const DEFAULT_PATH_LIMIT_PER_PLUGIN = 12;
const DEFAULT_DIFF_LIMIT_PER_PLUGIN = 4;
const DEFAULT_DIFF_LINE_LIMIT = 80;

export function groupReferenceChangesByPlugin(paths) {
  const grouped = new Map();

  for (const relativePath of [...paths].sort((left, right) => left.localeCompare(right))) {
    const parts = relativePath.split("/");
    if (parts.length < 4) continue;
    if (parts[0] !== "references" || parts[1] !== "upstream-plugins") continue;

    const pluginId = parts[2];
    if (!grouped.has(pluginId)) grouped.set(pluginId, []);
    grouped.get(pluginId).push(relativePath);
  }

  return grouped;
}

export function buildChangedPluginSummaries(previousLock, currentLock) {
  const summaries = [];

  for (const pluginId of Object.keys(currentLock.plugins).sort((left, right) => left.localeCompare(right))) {
    const previousVersion = previousLock?.plugins?.[pluginId]?.version ?? null;
    const currentVersion = currentLock.plugins[pluginId].version;

    if (previousVersion === currentVersion) continue;

    summaries.push({
      pluginId,
      previousVersion,
      currentVersion,
    });
  }

  return summaries;
}

function limitList(items, limit) {
  if (items.length <= limit) {
    return { omittedCount: 0, visibleItems: items };
  }

  return {
    omittedCount: items.length - limit,
    visibleItems: items.slice(0, limit),
  };
}

export function trimDiffPreview(diffText, maxLines = DEFAULT_DIFF_LINE_LIMIT) {
  const normalized = diffText.trim();
  if (!normalized) return { text: "(no diff preview available)", truncated: false };

  const lines = normalized.split("\n");
  if (lines.length <= maxLines) {
    return { text: normalized, truncated: false };
  }

  return {
    text: `${lines.slice(0, maxLines).join("\n")}\n... diff truncated ...`,
    truncated: true,
  };
}

function formatCheckOutcome(result) {
  const commandLabel = `\`${result.command}\``;

  if (result.ok) {
    return `- ${commandLabel}: passed`;
  }

  return `- ${commandLabel}: failed (exit ${result.exitCode ?? 1})`;
}

export function buildUpstreamPluginReviewPrompt({
  changedFilesByPlugin,
  changedPlugins,
  diffPreviewByPath,
  testResult,
  typecheckResult,
}) {
  const lines = [
    "Please check whether these upstream plugin updates conflict with the current local opencode-quota plugin.",
    "",
    "Updated plugins:",
  ];

  for (const summary of changedPlugins) {
    const previousLabel = summary.previousVersion ?? "none tracked";
    lines.push(`- ${summary.pluginId}: ${previousLabel} -> ${summary.currentVersion}`);
  }

  lines.push("", "Changed files:");

  for (const summary of changedPlugins) {
    const pluginPaths = changedFilesByPlugin.get(summary.pluginId) ?? [];
    const { omittedCount, visibleItems } = limitList(pluginPaths, DEFAULT_PATH_LIMIT_PER_PLUGIN);

    lines.push(`- ${summary.pluginId}:`);
    if (visibleItems.length === 0) {
      lines.push("  - No path-level diff captured; inspect the plugin directory locally.");
      continue;
    }

    for (const filePath of visibleItems) {
      lines.push(`  - ${filePath}`);
    }

    if (omittedCount > 0) {
      lines.push(`  - ... ${omittedCount} more changed files omitted from this prompt`);
    }
  }

  lines.push("", "Diff previews:");

  for (const summary of changedPlugins) {
    const pluginPaths = changedFilesByPlugin.get(summary.pluginId) ?? [];
    const { omittedCount, visibleItems } = limitList(pluginPaths, DEFAULT_DIFF_LIMIT_PER_PLUGIN);

    lines.push(`- ${summary.pluginId}:`);
    if (visibleItems.length === 0) {
      lines.push("  - No diff preview captured.");
      continue;
    }

    for (const filePath of visibleItems) {
      lines.push(`  - ${filePath}`);
      lines.push("```diff");
      lines.push(diffPreviewByPath.get(filePath) ?? "(no diff preview available)");
      lines.push("```");
    }

    if (omittedCount > 0) {
      lines.push(`  - ... ${omittedCount} more diff previews omitted`);
    }
  }

  lines.push("", "Checks:");
  lines.push(formatCheckOutcome(testResult));
  lines.push(formatCheckOutcome(typecheckResult));

  if (!testResult.ok && testResult.output) {
    lines.push("", `${testResult.command} output:`);
    lines.push("```text");
    lines.push(testResult.output.trim());
    lines.push("```");
  }

  if (!typecheckResult.ok && typecheckResult.output) {
    lines.push("", `${typecheckResult.command} output:`);
    lines.push("```text");
    lines.push(typecheckResult.output.trim());
    lines.push("```");
  }

  lines.push(
    "",
    "If you find no conflicts, I plan to close the GitHub issue manually. If you find conflicts, tell me exactly what changed in opencode-quota and what should be fixed before I push to main and cut a release.",
  );

  return `${lines.join("\n").trim()}\n`;
}

