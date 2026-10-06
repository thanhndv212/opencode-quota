import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, session } from "electron";

// This is an external fixture harness, never a production-mode bypass. Load
// the actual installed main/preload/renderer, replacing only data-provider IPC.
let fetches = 0;
const fixtures = {
  "quota:fetch": () => {
    fetches++;
    return {
      entries: [{ name: "Fixture quota", kind: "percent", percentRemaining: 75 }],
      errors: [],
      detectedProviderIds: ["openai"],
    };
  },
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
  else if (channel.startsWith("app:") || channel.startsWith("config:"))
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
}, 30_000);

async function waitFor(check, description) {
  const until = Date.now() + 10_000;
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
      () => evaluate('document.body.innerText.includes("Fixture quota")'),
      "fixture dashboard",
    );
    assert.equal(await evaluate("typeof window.quotaApi.quota.fetch"), "function");
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
    win.hide();
    win.webContents.send("app:refresh");
    await waitFor(() => fetches > before + 1, "tray refresh while hidden");
    assert.deepEqual(errors, []);
    clearTimeout(deadline);
    console.log(
      `Installed Electron GUI smoke passed: ${process.platform}, Electron ${process.versions.electron}, six tabs, refresh, version, preload`,
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
