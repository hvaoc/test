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
  # Sign + notarize every macOS build by default so it opens clean on any Mac.
  # Override per-build via env, e.g. `MACOS_SIGN_IDENTITY= NOTARY_PROFILE= npm run desktop`
  # for a quick unsigned build.
  : "${MACOS_SIGN_IDENTITY=Developer ID Application: Function of Q Technology Inc. (78QX5ZLWEA)}"
  : "${NOTARY_PROFILE=things-notary}"
fi
export LANG="${LANG:-en_US.UTF-8}"
export PATH="$PATH:$(go env GOPATH)/bin"

echo "▸ Building CRDT WASM…"
bash "$DESKTOP/build-wasm.sh"

echo "▸ Exporting Expo web build…"
cd "$ROOT"
npx expo export --platform web --output-dir dist-web >/dev/null

echo "▸ Injecting splash screen…"
python3 - "$ROOT/dist-web/index.html" "$DESKTOP/logo.svg" <<'PY'
import sys
html_path, logo_path = sys.argv[1], sys.argv[2]
with open(logo_path) as f: logo = f.read().strip()
with open(html_path) as f: html = f.read()
# Paint the persisted theme background before the bundle loads (no flash). On a
# first launch (no stored bg) fall back to the OS light/dark preference.
head_script = ("<script>try{var b=localStorage.getItem('appBg');"
               "if(!b){b=matchMedia('(prefers-color-scheme: dark)').matches?'#1e1e20':'#f5f6f8';}"
               "document.documentElement.style.setProperty('--splash-bg',b);}catch(e){}</script>")
splash = (
  "<style>#app-splash{position:fixed;inset:0;z-index:2147483647;display:flex;"
  "align-items:center;justify-content:center;background:var(--splash-bg,#f5f6f8);"
  "transition:opacity .32s ease}"
  "#app-splash svg{width:104px;height:104px;"
  "filter:drop-shadow(0 12px 26px rgba(43,111,255,.30));"
  "animation:app-splash-in .5s ease both,app-splash-breathe 2.4s ease-in-out .5s infinite}"
  "@keyframes app-splash-in{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}"
  "@keyframes app-splash-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}</style>"
  '<div id="app-splash">' + logo + "</div>"
)
if head_script not in html:
    html = html.replace("<head>", "<head>" + head_script, 1)
if 'id="app-splash"' not in html:
    if "</body>" in html:
        html = html.replace("</body>", splash + "</body>", 1)
    else:
        html = html.replace("</html>", splash + "</html>", 1)
with open(html_path, "w") as f: f.write(html)
print("  splash injected")
PY

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
    # Non-fatal: a missing/invalid notary profile must not discard a good signed
    # build — warn and continue so you still get a runnable, signed app.
    if /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP" \
      && xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait \
      && xcrun stapler staple "$APP" \
      && xcrun stapler validate "$APP"; then
      rm -f "$ZIP"
      echo "✓ Notarized + stapled — opens clean on any Mac."
    else
      rm -f "$ZIP"
      echo "⚠ Notarization skipped/failed — the '$NOTARY_PROFILE' keychain profile"
      echo "  isn't available. Recreate it with:"
      echo "    xcrun notarytool store-credentials \"$NOTARY_PROFILE\" --apple-id <id> --team-id 78QX5ZLWEA --password <app-specific-pw>"
      echo "  The app is signed; recipients can right-click → Open until then."
    fi
  else
    echo "⚠ Signed but NOT notarized (set NOTARY_PROFILE to notarize). Other Macs will still warn."
  fi
else
  echo "ℹ Unsigned build. Set MACOS_SIGN_IDENTITY (+ NOTARY_PROFILE) to sign/notarize."
fi
