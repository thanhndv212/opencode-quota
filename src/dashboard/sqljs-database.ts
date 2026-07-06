/**
 * Read-oriented DatabaseLike adapter over sql.js (WASM SQLite, no native
 * module) — lets DashboardApi run inside the Electron main process, which
 * cannot load better-sqlite3: that native module is compiled against
 * system Node's ABI, and Electron's bundled V8/Node uses a different one
 * (confirmed via a real `npmRebuild: true` packaging attempt — better-sqlite3
 * 12.10.0's C++ source doesn't compile against Electron 42's V8 headers).
 *
 * The plugin process remains the sole writer, via better-sqlite3 in its own
 * real-Node process (see dashboard-instance.ts) — no ABI conflict there.
 * This adapter only ever reads, and re-opens the file from disk whenever its
 * mtime changes, so it reflects the plugin's latest writes instead of
 * serving a stale in-memory snapshot for the Electron app's whole lifetime.
 * Writes made through it (only ever DashboardApi's internal migrateSchema(),
 * when the file has no schema yet) are never persisted back to disk — by
 * design, since a second writer here would race with the plugin's own file
 * writes.
 */

import { existsSync, readFileSync, statSync } from "fs";
import initSqlJs, { type Database as SqlJsDb } from "sql.js";

interface PreparedLike {
  get(...params: unknown[]): any;
  run(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export class SqlJsDatabaseAdapter {
  private cachedDb: SqlJsDb | null = null;
  private cachedMtimeMs = -1;

  private constructor(
    private readonly SQL: Awaited<ReturnType<typeof initSqlJs>>,
    private readonly dbPath: string,
  ) {}

  static async open(dbPath: string): Promise<SqlJsDatabaseAdapter> {
    const SQL = await initSqlJs();
    return new SqlJsDatabaseAdapter(SQL, dbPath);
  }

  private getDb(): SqlJsDb {
    const mtimeMs = existsSync(this.dbPath) ? statSync(this.dbPath).mtimeMs : -1;
    if (this.cachedDb && mtimeMs === this.cachedMtimeMs) return this.cachedDb;

    this.cachedDb?.close();
    const buffer = mtimeMs >= 0 ? readFileSync(this.dbPath) : undefined;
    this.cachedDb = new this.SQL.Database(buffer);
    this.cachedMtimeMs = mtimeMs;
    return this.cachedDb;
  }

  prepare(sql: string): PreparedLike {
    return {
      get: (...params: unknown[]) => {
        const stmt = this.getDb().prepare(sql);
        try {
          stmt.bind(params as any);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally {
          stmt.free();
        }
      },
      all: (...params: unknown[]) => {
        const stmt = this.getDb().prepare(sql);
        const rows: any[] = [];
        try {
          stmt.bind(params as any);
          while (stmt.step()) rows.push(stmt.getAsObject());
        } finally {
          stmt.free();
        }
        return rows;
      },
      run: (...params: unknown[]) => {
        const db = this.getDb();
        const stmt = db.prepare(sql);
        try {
          stmt.bind(params as any);
          stmt.step();
        } finally {
          stmt.free();
        }
        return { changes: db.getRowsModified() };
      },
    };
  }

  exec(sql: string): void {
    this.getDb().run(sql);
  }

  close(): void {
    this.cachedDb?.close();
    this.cachedDb = null;
    this.cachedMtimeMs = -1;
  }
}
