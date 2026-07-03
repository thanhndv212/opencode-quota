/**
 * Database migration for dashboard historical tracking
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: any[]): any;
    run(...params: any[]): any;
    all(...params: any[]): any[];
  };
}

export function migrateSchema(db: DatabaseLike): void {
  try {
    // Check current version
    let currentVersion = 0;
    try {
      const row = db
        .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
        .get();
      currentVersion = row?.version || 0;
    } catch {
      // Table doesn't exist yet, version is 0
    }

    console.log(`Current dashboard schema version: ${currentVersion}`);

    if (currentVersion < 1) {
      console.log("Applying dashboard schema v1...");
      const schemaPath = join(__dirname, "schema.sql");
      const schemaSql = readFileSync(schemaPath, "utf-8");
      db.exec(schemaSql);
      console.log("✓ Dashboard schema v1 applied");
    }

    // Future migrations
    // if (currentVersion < 2) {
    //   db.exec("ALTER TABLE ...");
    //   db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (2, ?)").run(Date.now());
    // }
  } catch (err) {
    console.error("Failed to migrate dashboard schema:", err);
    throw err;
  }
}
