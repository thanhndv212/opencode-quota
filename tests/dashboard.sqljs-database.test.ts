import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SqlJsDatabaseAdapter } from "../src/dashboard/sqljs-database.js";
import { DashboardApi } from "../src/dashboard/api.js";

describe("SqlJsDatabaseAdapter", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the schema in-memory and serves reads when the db file doesn't exist yet", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sqljs-adapter-test-"));
    const dbPath = join(tmpDir, "quota-dashboard.db");

    const adapter = await SqlJsDatabaseAdapter.open(dbPath);
    const api = new DashboardApi(adapter as any);

    expect(api.getCurrentQuota("anthropic")).toBeNull();
    expect(api.getQuotaHistory("anthropic", 7)).toEqual([]);
    expect(api.getModelBreakdown("anthropic", 7)).toEqual([]);
    expect(api.getWeeklyResets("anthropic", 4)).toEqual([]);
  });

  it("reads real quota snapshot data written by a separate better-sqlite3-backed DashboardApi", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sqljs-adapter-test-"));
    const dbPath = join(tmpDir, "quota-dashboard.db");

    const Database = (await import("better-sqlite3")).default;
    const writerDb = new Database(dbPath);
    const writerApi = new DashboardApi(writerDb as any);
    writerApi.captureSnapshot("anthropic", { limits: [{ kind: "session", percent: 42 }], percentRemaining: 58 });
    writerDb.close();

    const adapter = await SqlJsDatabaseAdapter.open(dbPath);
    const readerApi = new DashboardApi(adapter as any);

    expect(readerApi.getCurrentQuota("anthropic")).toEqual({
      limits: [{ kind: "session", percent: 42 }],
      percentRemaining: 58,
    });
  });

  it("picks up writes made after open(), by reloading when the file's mtime changes", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sqljs-adapter-test-"));
    const dbPath = join(tmpDir, "quota-dashboard.db");

    const Database = (await import("better-sqlite3")).default;

    const initialWriterDb = new Database(dbPath);
    new DashboardApi(initialWriterDb as any); // just to create the schema
    initialWriterDb.close();

    const adapter = await SqlJsDatabaseAdapter.open(dbPath);
    const readerApi = new DashboardApi(adapter as any);
    expect(readerApi.getCurrentQuota("anthropic")).toBeNull();

    // Simulate the plugin process writing a new snapshot later, from a
    // completely separate better-sqlite3 connection.
    const laterWriterDb = new Database(dbPath);
    const laterWriterApi = new DashboardApi(laterWriterDb as any);
    laterWriterApi.captureSnapshot("anthropic", { limits: [], percentRemaining: 91 });
    laterWriterDb.close();
    // Some filesystems have 1s mtime granularity; force it forward so this
    // test doesn't depend on real wall-clock time passing between writes.
    const bumpedMtime = new Date(Date.now() + 60_000);
    utimesSync(dbPath, bumpedMtime, bumpedMtime);

    expect(readerApi.getCurrentQuota("anthropic")).toEqual({ limits: [], percentRemaining: 91 });
  });

  it("does not persist writes back to disk (migrateSchema's table creation stays in-memory only)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sqljs-adapter-test-"));
    const dbPath = join(tmpDir, "quota-dashboard.db");

    // No file exists yet — open() creates the schema in an ephemeral in-memory copy.
    const adapter = await SqlJsDatabaseAdapter.open(dbPath);
    new DashboardApi(adapter as any);

    const { existsSync } = await import("fs");
    expect(existsSync(dbPath)).toBe(false);
  });
});
