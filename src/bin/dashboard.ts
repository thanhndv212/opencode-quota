#!/usr/bin/env node

/**
 * CLI entry point for dashboard server
 * Usage: opencode-quota dashboard [--port 3939]
 */

import { startDashboardServer } from "../dashboard/server.js";
import { DashboardApi } from "../dashboard/api.js";
import { getOpenCodeDbPath } from "../lib/opencode-storage.js";
import { join, dirname } from "path";

async function main() {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3939;

  if (isNaN(port)) {
    console.error("Invalid port number");
    process.exit(1);
  }

  try {
    // Create dashboard database (separate from OpenCode main DB)
    const openCodeDbPath = getOpenCodeDbPath();
    const dashboardDbPath = join(dirname(openCodeDbPath), "quota-dashboard.db");
    console.log(`📂 Using database: ${dashboardDbPath}`);

    // Use better-sqlite3 directly for simpler implementation
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dashboardDbPath) as any; // Cast to any to avoid type mismatch
    const dashboardApi = new DashboardApi(db);

    const server = await startDashboardServer({
      port,
      dashboardApi,
    });

    // Graceful shutdown
    process.on("SIGINT", () => {
      console.log("\n👋 Shutting down dashboard server...");
      dashboardApi.close();
      server.close(() => {
        console.log("✓ Server stopped");
        process.exit(0);
      });
    });

    process.on("SIGTERM", () => {
      dashboardApi.close();
      server.close();
      process.exit(0);
    });
  } catch (err) {
    console.error("Failed to start dashboard server:", err);
    process.exit(1);
  }
}

main();
