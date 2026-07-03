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

APP="$(ls -d "$DESKTOP"/build/bin/*.app | head -1)"
echo "✓ Built: $APP"

# ── Optional: codesign + notarize for distribution ─────────────────────────
# Set MACOS_SIGN_IDENTITY to a "Developer ID Application: … (TEAMID)" identity
# to sign with a hardened runtime; also set NOTARY_PROFILE (a stored
# `xcrun notarytool store-credentials` profile) to notarize + staple so the app
# opens with no Gatekeeper warning on other Macs. Plain builds stay unsigned.
if [[ "$PLATFORM" == darwin/* && -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  echo "▸ Codesigning (Developer ID, hardened runtime)…"
  codesign --force --options runtime --timestamp \
    ${MACOS_ENTITLEMENTS:+--entitlements "$MACOS_ENTITLEMENTS"} \
    --sign "$MACOS_SIGN_IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"
  echo "✓ Signed."

  if [[ -n "${NOTARY_PROFILE:-}" ]]; then
    echo "▸ Notarizing (waits for Apple)…"
    ZIP="${APP%.app}.zip"
    /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
    xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP"
    xcrun stapler validate "$APP"
    rm -f "$ZIP"
    echo "✓ Notarized + stapled — opens clean on any Mac."
  else
    echo "⚠ Signed but NOT notarized (set NOTARY_PROFILE to notarize). Other Macs will still warn."
  fi
else
  echo "ℹ Unsigned build. Set MACOS_SIGN_IDENTITY (+ NOTARY_PROFILE) to sign/notarize."
fi
