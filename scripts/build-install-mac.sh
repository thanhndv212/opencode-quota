#!/usr/bin/env bash
set -euo pipefail

# Build and install OpenCode Quota on macOS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$ROOT_DIR/release"

APP_NAME="OpenCode Quota.app"

cd "$ROOT_DIR"

echo "==> Building TypeScript..."
pnpm run build

echo "==> Building GUI renderer..."
pnpm run build:gui

echo "==> Generating icons..."
pnpm run build:icons

echo "==> Packaging for macOS with electron-builder..."
NODE_OPTIONS="--experimental-require-module" npx electron-builder --mac

echo "==> Build complete."

# --- Install ---
echo ""
echo "==> Looking for $APP_NAME in $RELEASE_DIR ..."

APP_PATH=$(find "$RELEASE_DIR" -maxdepth 2 -type d -name "$APP_NAME" 2>/dev/null | head -1 || true)

if [ -z "$APP_PATH" ]; then
  DMG_FILE=$(ls "$RELEASE_DIR"/*.dmg 2>/dev/null | head -1 || true)
  if [ -n "$DMG_FILE" ]; then
    echo "ERROR: Found .dmg ($DMG_FILE) but no extracted .app bundle."
    echo "Either mount the .dmg and drag to /Applications, or run:"
    echo "  hdiutil attach $DMG_FILE"
    echo "  cp -R '/Volumes/$APP_NAME/$APP_NAME' /Applications/"
    echo "  hdiutil detach '/Volumes/$APP_NAME'"
    exit 1
  fi
  echo "ERROR: No $APP_NAME found in $RELEASE_DIR"
  exit 1
fi

INSTALL_PATH="/Applications/$APP_NAME"

echo "==> Found: $APP_PATH"
echo "==> Removing existing install at $INSTALL_PATH ..."
rm -rf "$INSTALL_PATH"

echo "==> Copying to /Applications ..."
cp -R "$APP_PATH" "$INSTALL_PATH"

echo "==> Installed to: $INSTALL_PATH"
echo "==> Run from /Applications or with: open /Applications/$APP_NAME"
