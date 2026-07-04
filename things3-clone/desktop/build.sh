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

# macOS builds need a developer toolchain (CGO/WebKit). Use whichever is active
# — full Xcode or just the Command Line Tools — instead of assuming Xcode.app.
if [[ "$PLATFORM" == darwin/* ]]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || echo /Library/Developer/CommandLineTools)}"
  # Preferred signing identity + notary profile. These are only USED if they're
  # actually available in the keychain (checked after the build); on a machine
  # without them the build simply stays unsigned instead of failing. Override to
  # '' to force an unsigned build: `MACOS_SIGN_IDENTITY= npm run desktop`.
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

# ── Codesign + notarize (only when the toolchain is fully available) ────────
# The app is signed with a hardened runtime IF a Developer ID Application
# identity is in the keychain, and additionally notarized + stapled IF a valid
# notary profile exists. Anything missing → the build stays as-is (Wails already
# ad-hoc self-signs it, so it runs locally). Nothing here can fail the build.
if [[ "$PLATFORM" == darwin/* ]]; then
  # Resolve a usable signing identity: the preferred one if it's present, else
  # the first Developer ID Application identity in the keychain.
  SIGN_ID=""
  if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]] \
     && security find-identity -v -p codesigning 2>/dev/null | grep -qF "$MACOS_SIGN_IDENTITY"; then
    SIGN_ID="$MACOS_SIGN_IDENTITY"
  else
    SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null \
      | grep -o '"Developer ID Application:[^"]*"' | head -1 | tr -d '"' || true)"
  fi

  if [[ -z "$SIGN_ID" ]]; then
    echo "ℹ No Developer ID Application identity in the keychain — leaving the"
    echo "  build ad-hoc self-signed (runs on this Mac). Install a Developer ID"
    echo "  cert to produce a distributable signed build."
  elif codesign --force --options runtime --timestamp \
         ${MACOS_ENTITLEMENTS:+--entitlements "$MACOS_ENTITLEMENTS"} \
         --sign "$SIGN_ID" "$APP" \
       && codesign --verify --strict --verbose=2 "$APP"; then
    echo "✓ Signed (Developer ID, hardened runtime): $SIGN_ID"

    # Notarize if a notary profile is set. We attempt it rather than pre-probing
    # (a network 'notarytool history' check is flaky); a bad/missing profile just
    # fails the submit below and is handled non-fatally.
    if [[ -n "${NOTARY_PROFILE:-}" ]]; then
      echo "▸ Notarizing with profile '$NOTARY_PROFILE' (waits for Apple)…"
      ZIP="${APP%.app}.zip"
      if /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP" \
        && xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait \
        && xcrun stapler staple "$APP" \
        && xcrun stapler validate "$APP"; then
        rm -f "$ZIP"
        echo "✓ Notarized + stapled — opens clean on any Mac."
      else
        rm -f "$ZIP"
        echo "⚠ Notarization failed — the app is SIGNED but not notarized."
        echo "  Recipients can right-click → Open until it's notarized."
      fi
    else
      echo "ℹ Signed but NOT notarized (no usable NOTARY_PROFILE). Create one with:"
      echo "    xcrun notarytool store-credentials <name> --apple-id <id> --team-id <TEAMID> --password <app-specific-pw>"
      echo "  then re-run with NOTARY_PROFILE=<name>."
    fi
  else
    echo "⚠ Codesign failed — leaving the ad-hoc self-signed build."
  fi
fi
