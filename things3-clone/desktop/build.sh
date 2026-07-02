#!/usr/bin/env bash
# Build the desktop app: export the Expo web build, embed it, and package it
# with Wails into a native app.
#
# Usage:  bash desktop/build.sh [platform]
#   platform defaults to darwin/arm64. Examples:
#     darwin/arm64      Apple-silicon macOS (default)
#     darwin/amd64      Intel macOS
#     darwin/universal  Universal macOS (arm64 + amd64)
#     windows/amd64     Windows (build on Windows; see desktop/README.md)
set -euo pipefail

PLATFORM="${1:-darwin/arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # things3-clone/
DESKTOP="$ROOT/desktop"

# macOS builds need the full Xcode toolchain (CGO/WebKit).
if [[ "$PLATFORM" == darwin/* ]]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
fi
export LANG="${LANG:-en_US.UTF-8}"
export PATH="$PATH:$(go env GOPATH)/bin"

echo "▸ Exporting Expo web build…"
cd "$ROOT"
npx expo export --platform web --output-dir dist-web >/dev/null

echo "▸ Embedding web build into Wails frontend…"
rm -rf "$DESKTOP/frontend/dist"
cp -R "$ROOT/dist-web" "$DESKTOP/frontend/dist"

echo "▸ Building Wails app for ${PLATFORM} …"
cd "$DESKTOP"
wails build -platform "$PLATFORM" -clean

echo "✓ Built: $DESKTOP/build/bin/things3-clone.app"
