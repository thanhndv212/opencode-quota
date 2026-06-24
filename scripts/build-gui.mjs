/**
 * Build script for the Electron menubar GUI app.
 *
 * This script:
 * 1. Copies renderer files (HTML, CSS, JS) to dist/gui/renderer/
 * 2. Copies Solid.js vendor files to dist/gui/renderer/vendor/
 * 3. Ensures the preload.js is compiled alongside main.js by tsc
 *
 * Run: node scripts/build-gui.mjs
 */

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const srcDir = join(rootDir, "src", "gui");
const distDir = join(rootDir, "dist", "gui");
const rendererSrc = join(srcDir, "renderer");
const rendererDist = join(distDir, "renderer");
const vendorDist = join(rendererDist, "vendor");

async function main() {
  console.log("Building GUI renderer...");

  // Create output directories
  await mkdir(rendererDist, { recursive: true });
  await mkdir(vendorDist, { recursive: true });
  await mkdir(join(rendererDist, "styles"), { recursive: true });

  // Copy renderer HTML
  console.log("  Copying renderer HTML...");
  await cp(join(rendererSrc, "index.html"), join(rendererDist, "index.html"));

  // Copy renderer JS
  console.log("  Copying renderer JS...");
  await cp(join(rendererSrc, "app.js"), join(rendererDist, "app.js"));

  // Copy CSS
  console.log("  Copying CSS...");
  await cp(join(rendererSrc, "styles", "app.css"), join(rendererDist, "styles", "app.css"));

  // Bundle Solid.js vendor files from node_modules
  console.log("  Bundling Solid.js vendor files...");
  await bundleSolidJs();

  console.log("GUI renderer build complete!");
  console.log(`  Output: ${rendererDist}`);
}

async function bundleSolidJs() {
  // Solid.js is already a dependency, but we need the web (DOM) build
  // for the Electron renderer, not the @opentui/solid (TUI) build.
  // We create a minimal shim that exposes the html tagged template API.

  const solidHtmlPath = findSolidHtmlModule();
  const solidWebPath = findSolidWebModule();

  if (solidWebPath) {
    await cp(solidWebPath, join(vendorDist, "solid.min.js"));
    console.log("    Found solid-js/web at:", solidWebPath);
  } else {
    console.warn("    WARNING: solid-js/web not found. Creating shim...");
    await createSolidShim();
  }

  if (solidHtmlPath) {
    await cp(solidHtmlPath, join(vendorDist, "solid-jsx-runtime.js"));
    console.log("    Found solid-js/html at:", solidHtmlPath);
  } else {
    console.warn("    WARNING: solid-js/html not found. Creating shim...");
    await createSolidHtmlShim();
  }
}

function findSolidWebModule() {
  const candidates = [
    join(rootDir, "node_modules", "solid-js", "web", "dist", "web.js"),
    join(rootDir, "node_modules", "solid-js", "dist", "solid.js"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function findSolidHtmlModule() {
  const candidates = [
    join(rootDir, "node_modules", "solid-js", "html", "dist", "html.js"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

async function createSolidShim() {
  // Create a minimal Solid.js global that provides the html tagged template API
  // In production, users should run `npm install solid-js` for the full build.
  const shim = `
// Minimal Solid.js shim for OpenCode Quota GUI
// Install solid-js for full functionality: npm install solid-js
window.SolidHTML = (function() {
  'use strict';

  // Signal implementation
  function createSignal(value) {
    const listeners = new Set();
    const read = () => value;
    const write = (next) => {
      if (next !== value) {
        value = typeof next === 'function' ? next(value) : next;
        listeners.forEach(fn => fn());
      }
    };
    return [read, write];
  }

  function createMemo(fn) {
    const [s, set] = createSignal();
    createEffect(() => set(fn()));
    return s;
  }

  function createEffect(fn) {
    fn();
  }

  function onMount(fn) { queueMicrotask(fn); }
  function onCleanup(fn) {}
  function createResource() { return [() => null, {}]; }

  // Simple tagged template html\`\` implementation
  function html(strings, ...values) {
    return function() {
      let result = '';
      for (let i = 0; i < strings.length; i++) {
        result += strings[i];
        if (i < values.length) {
          const v = values[i];
          if (typeof v === 'function') {
            result += escapeHtml(String(v()));
          } else if (v != null) {
            result += escapeHtml(String(v));
          }
        }
      }
      return result;
    };
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Render function
  function render(component, root) {
    const result = component();
    const content = typeof result === 'function' ? result() : String(result);
    root.innerHTML = content;
  }

  // Show/Match components
  function Show(props) { return props.when ? props.children : props.fallback; }
  function For(props) { return (props.each || []).map(props.children).join(''); }
  function Switch(props) { return props.children; }
  function Match(props) { return props.when ? props.children : null; }
  function Suspense(props) { return props.children; }
  function ErrorBoundary(props) { return props.children; }

  return {
    html, render, createSignal, createMemo, createEffect,
    onMount, onCleanup, createResource,
    Show, For, Switch, Match, Suspense, ErrorBoundary,
  };
})();
`;
  await writeFile(join(vendorDist, "solid.min.js"), shim, "utf-8");
}

async function createSolidHtmlShim() {
  // The html tagged template is included in the main shim above
  const shim = `// solid-js/html placeholder — included in solid.min.js shim\n`;
  await writeFile(join(vendorDist, "solid-jsx-runtime.js"), shim, "utf-8");
}

main().catch((err) => {
  console.error("GUI build failed:", err);
  process.exit(1);
});
