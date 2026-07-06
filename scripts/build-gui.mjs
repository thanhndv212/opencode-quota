/**
 * Build script for the Electron menubar GUI app.
 *
 * This script copies renderer files (HTML, CSS, JS) to dist/gui/renderer/.
 * The renderer itself is plain vanilla JS/DOM (src/gui/renderer/app.js) —
 * no framework, no bundler needed.
 *
 * Run: node scripts/build-gui.mjs
 */

import { cp, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const srcDir = join(rootDir, "src", "gui");
const distDir = join(rootDir, "dist", "gui");
const rendererSrc = join(srcDir, "renderer");
const rendererDist = join(distDir, "renderer");

async function main() {
  console.log("Building GUI renderer...");

  await mkdir(rendererDist, { recursive: true });
  await mkdir(join(rendererDist, "styles"), { recursive: true });

  console.log("  Copying renderer HTML...");
  await cp(join(rendererSrc, "index.html"), join(rendererDist, "index.html"));

  console.log("  Copying renderer JS...");
  await cp(join(rendererSrc, "app.js"), join(rendererDist, "app.js"));

  console.log("  Copying CSS...");
  await cp(join(rendererSrc, "styles", "app.css"), join(rendererDist, "styles", "app.css"));

  console.log("GUI renderer build complete!");
  console.log(`  Output: ${rendererDist}`);
}

main().catch((err) => {
  console.error("GUI build failed:", err);
  process.exit(1);
});
