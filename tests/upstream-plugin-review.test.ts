import { describe, expect, it } from "vitest";

import {
  buildChangedPluginSummaries,
  buildUpstreamPluginReviewPrompt,
  groupReferenceChangesByPlugin,
} from "../scripts/lib/upstream-plugin-review.mjs";

describe("upstream-plugin-review", () => {
  it("builds changed plugin summaries from lock versions", () => {
    expect(
      buildChangedPluginSummaries(
        {
          plugins: {
            "opencode-qwencode-auth": { version: "1.2.0" },
          },
        },
        {
          plugins: {
            "opencode-antigravity-auth": { version: "1.6.0" },
            "opencode-qwencode-auth": { version: "1.3.0" },
          },
        },
      ),
    ).toEqual([
      {
        currentVersion: "1.6.0",
        pluginId: "opencode-antigravity-auth",
        previousVersion: null,
      },
      {
        currentVersion: "1.3.0",
        pluginId: "opencode-qwencode-auth",
        previousVersion: "1.2.0",
      },
    ]);
  });

  it("groups changed reference files by plugin", () => {
    const grouped = groupReferenceChangesByPlugin([
      "references/upstream-plugins/opencode-qwencode-auth/package.json",
      "references/upstream-plugins/opencode-qwencode-auth/src/index.ts",
      "references/upstream-plugins/opencode-antigravity-auth/dist/index.js",
      "references/upstream-plugins/lock.json",
    ]);

    expect(grouped.get("opencode-qwencode-auth")).toEqual([
      "references/upstream-plugins/opencode-qwencode-auth/package.json",
      "references/upstream-plugins/opencode-qwencode-auth/src/index.ts",
    ]);
    expect(grouped.get("opencode-antigravity-auth")).toEqual([
      "references/upstream-plugins/opencode-antigravity-auth/dist/index.js",
    ]);
  });

  it("builds a ready-to-paste review prompt with paths, diffs, and check results", () => {
    const prompt = buildUpstreamPluginReviewPrompt({
      changedFilesByPlugin: new Map([
        [
          "opencode-qwencode-auth",
          [
            "references/upstream-plugins/opencode-qwencode-auth/package.json",
            "references/upstream-plugins/opencode-qwencode-auth/src/index.ts",
          ],
        ],
      ]),
      changedPlugins: [
        {
          currentVersion: "1.3.0",
          pluginId: "opencode-qwencode-auth",
          previousVersion: "1.2.0",
        },
      ],
      diffPreviewByPath: new Map([
        [
          "references/upstream-plugins/opencode-qwencode-auth/package.json",
          "--- a/references/upstream-plugins/opencode-qwencode-auth/package.json\n+++ b/references/upstream-plugins/opencode-qwencode-auth/package.json\n@@\n-  \"version\": \"1.2.0\"\n+  \"version\": \"1.3.0\"",
        ],
      ]),
      testResult: {
        command: "pnpm test",
        exitCode: 0,
        ok: true,
        output: "",
      },
      typecheckResult: {
        command: "pnpm run typecheck",
        exitCode: 1,
        ok: false,
        output: "Type error here",
      },
    });

    expect(prompt).toContain("Please check whether these upstream plugin updates conflict");
    expect(prompt).toContain("opencode-qwencode-auth: 1.2.0 -> 1.3.0");
    expect(prompt).toContain("references/upstream-plugins/opencode-qwencode-auth/package.json");
    expect(prompt).toContain("\"version\": \"1.3.0\"");
    expect(prompt).toContain("`pnpm test`: passed");
    expect(prompt).toContain("`pnpm run typecheck`: failed");
    expect(prompt).toContain("Type error here");
  });
});
