import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, session, Menu, powerMonitor } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// This is an external fixture harness, never a production-mode bypass. Load
// the actual installed main/preload/renderer/controller/provider pipeline.
// Quota HTTP is fixture-backed; unrelated tab IPC remains fixture-backed.
let fetches = 0;
let failNext = false;
let responseDelayMs = 0;
globalThis.fetch = async (input, options) => {
  assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(options.headers.Authorization, "Bearer gui-smoke-fixture-token");
  fetches++;
  if (responseDelayMs) await new Promise((done) => setTimeout(done, responseDelayMs));
  if (failNext) {
    failNext = false;
    return new Response("Fixture offline", { status: 503 });
  }
  return new Response(
    JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3600,
        },
      },
    }),
    { status: 200 },
  );
};
let trayRefresh;
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => {
  trayRefresh = template.find((item) => item.label === "Refresh Quota")?.click;
  return buildMenu(template);
};
const fixtures = {
  "tokens:query": () => ({
    aggregate: { totals: { costUsd: 0 }, bySourceModel: [], bySession: [] },
    window: { label: "7 days" },
  }),
  "alerts:list": () => [],
  "pricing:list": () => ({ overrides: [], snapshot: null }),
  "apikeys:status": () => ({ state: "empty" }),
  "dashboardHistory:listProviders": () => [],
};
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  if (fixtures[channel]) realHandle(channel, fixtures[channel]);
  else if (
    channel.startsWith("app:") ||
    channel.startsWith("config:") ||
    channel.startsWith("quota:")
  )
    realHandle(channel, handler);
  else
    realHandle(channel, () => {
      throw new Error(`Unexpected fixture IPC: ${channel}`);
    });
};

const errors = [];
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _path, error) => errors.push(error.message));
  contents.on("console-message", (_event, details) => {
    if (details.level === "error") errors.push(details.message);
  });
  contents.on("render-process-gone", (_event, details) => errors.push(JSON.stringify(details)));
});
const deadline = setTimeout(() => {
  console.error("GUI smoke timed out", errors);
  app.exit(1);
}, 45_000);

async function waitFor(check, description) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}

async function smoke() {
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_details, callback) => {
        errors.push("Unexpected GUI network request");
        callback({ cancel: true });
      },
    );
    await import(pathToFileURL(process.env.QUOTA_SMOKE_MAIN).href);
    await waitFor(() => BrowserWindow.getAllWindows().length > 0, "main window");
    const win = BrowserWindow.getAllWindows()[0];
    const evaluate = (code) => win.webContents.executeJavaScript(code);
    await waitFor(
      () => evaluate('document.body.innerText.includes("OpenAI (Plus)")'),
      "fixture dashboard",
    );
    assert.equal(await evaluate("typeof window.quotaApi.quota.fetch"), "function");
    const settings = await evaluate("window.quotaApi.config.quota()");
    assert.equal(fetches, 1, "startup must query once, independent of renderer startup");
    assert.deepEqual(settings.config.enabledProviders, ["openai"]);
    assert.equal(settings.config.cursorPlan, "pro");
    assert.equal(settings.config.requestTimeoutMs, 9000);
    assert.deepEqual(settings.meta.workspaceConfigPaths, []);
    assert.equal(settings.meta.globalConfigPaths.length, 1);
    await writeFile(
      join(process.env.XDG_CONFIG_HOME, "opencode", "opencode-quota", "quota-toast.json"),
      JSON.stringify({
        enabledProviders: ["openai"],
        minIntervalMs: 1,
        requestTimeoutMs: 12000,
        pricingSnapshot: { source: "bundled", autoRefresh: 0 },
      }),
    );
    const reloaded = await evaluate("window.quotaApi.config.reloadQuota()");
    assert.equal(reloaded.config.requestTimeoutMs, 12000);
    assert.equal(
      await evaluate("window.quotaApi.app.getVersion()"),
      process.env.QUOTA_SMOKE_VERSION,
    );
    for (const [index, expected] of [
      [1, "7 days"],
      [2, "No budget alerts configured"],
      [3, "override"],
      [4, "Create"],
      [5, "History"],
    ]) {
      await evaluate(`document.querySelectorAll('.tab-btn')[${index}].click()`);
      await waitFor(
        () => evaluate(`document.body.innerText.includes(${JSON.stringify(expected)})`),
        `tab ${index}`,
      );
    }
    await evaluate("document.querySelectorAll('.tab-btn')[0].click()");
    const before = fetches;
    await evaluate("document.querySelector('.btn-refresh').click()");
    await waitFor(() => fetches > before, "manual refresh");
    await waitFor(
      () => evaluate("window.quotaApi.quota.state().then(s => !s.fetching)"),
      "manual completion",
    );
    await evaluate("window.quotaApi.config.update({ refreshIntervalMs: 10000 })");
    win.hide();
    const beforeTimer = fetches;
    await waitFor(() => fetches === beforeTimer + 1, "scheduled refresh while hidden");
    await waitFor(
      () => evaluate("window.quotaApi.quota.state().then(s => !s.fetching)"),
      "timer completion",
    );
    assert.equal(typeof trayRefresh, "function");
    trayRefresh();
    await waitFor(() => fetches === beforeTimer + 2, "real tray refresh while hidden");
    await waitFor(
      () => evaluate("window.quotaApi.quota.state().then(s => !s.fetching)"),
      "tray completion",
    );
    // Suspend/resume goes through actual main-process power event handlers.
    powerMonitor.emit("suspend");
    assert.equal((await evaluate("window.quotaApi.quota.state()")).nextRefreshAt, null);
    powerMonitor.emit("resume");
    await waitFor(() => fetches === beforeTimer + 3, "wake refresh");
    await waitFor(
      () => evaluate("window.quotaApi.quota.state().then(s => !s.fetching)"),
      "wake completion",
    );
    await evaluate("window.quotaApi.config.update({ refreshIntervalMs: 0 })");
    win.show();
    await evaluate(
      "window.quotaApi.quota.state().then(s => { if (s.nextRefreshAt !== null) throw new Error('timer still active'); })",
    );
    responseDelayMs = 150;
    const beforeOverlap = fetches;
    await evaluate(
      "Promise.all(Array.from({ length: 5 }, () => window.quotaApi.quota.fetch(true)))",
    );
    assert.equal(fetches, beforeOverlap + 1, "overlapping manual calls must share one HTTP query");
    responseDelayMs = 0;
    failNext = true;
    const failed = await evaluate("window.quotaApi.quota.fetch(true)");
    assert.equal(failed.stale, true);
    assert.equal(failed.previousObservation, true);
    assert.equal(failed.entries.length, 1);
    await waitFor(
      () => evaluate('document.body.innerText.includes("Showing previous observation")'),
      "stale state in renderer",
    );
    const recovered = await evaluate("window.quotaApi.quota.fetch(true)");
    assert.equal(recovered.stale, false);
    assert.equal(recovered.previousObservation, false);
    await waitFor(
      () =>
        evaluate(
          'document.querySelector(".quota-refresh-status").innerText.startsWith("Updated ")',
        ),
      "renderer recovery",
    );
    await evaluate(
      "window.__smokeUpdates = 0; window.__smokeUnsubscribe = window.quotaApi.quota.onUpdate(() => window.__smokeUpdates++); undefined",
    );
    await evaluate("window.quotaApi.quota.fetch(true)");
    assert.equal(await evaluate("window.__smokeUpdates"), 2);
    await evaluate("window.__smokeUnsubscribe()");
    await evaluate("window.quotaApi.quota.fetch(true)");
    assert.equal(
      await evaluate("window.__smokeUpdates"),
      2,
      "unsubscribe removes only its own listener",
    );
    assert.deepEqual(errors, []);
    clearTimeout(deadline);
    console.log(
      `Installed Electron GUI smoke passed: ${process.platform}, Electron ${process.versions.electron}, six tabs, config, startup/timer/tray/wake/coalesced HTTP refresh, stale/recovery, unsubscribe, version, preload`,
    );
    await evaluate("window.quotaApi.app.quit()");
  } catch (error) {
    console.error(error, errors);
    clearTimeout(deadline);
    app.exit(1);
  }
}

// Electron waits for the ESM main module to finish evaluating before ready.
// Waiting for ready with top-level await would deadlock the bootstrap.
void smoke();
