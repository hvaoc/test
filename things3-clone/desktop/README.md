# Desktop app (macOS) — Wails

The macOS desktop app wraps the **Expo web build** in a native
[Wails](https://wails.io) window (system WebKit — no bundled Chromium, ~14 MB).
The app is fully client-side (localStorage), so it runs offline with no backend.

> Why Wails and not react-native-macos? The out-of-tree react-native-macos
> platform couldn't render this stack: the New Architecture (required by
> Reanimated) doesn't mount a Fabric surface on macOS, and the old architecture
> crashes in the dev JS-inspector. Wails renders the same web UI reliably.

## Prerequisites (one time)

- **Go** ≥ 1.23 — `brew install go`
- **Wails v2** — `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
  (puts `wails` in `$(go env GOPATH)/bin`; make sure that's on your `PATH`)
- **Full Xcode** (not just Command Line Tools) — Wails' macOS build uses CGO +
  WebKit. Point the toolchain at it once:
  `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`

## Build

From the repo root (`things3-clone/`):

```bash
npm run desktop            # Apple silicon (darwin/arm64)
npm run desktop:intel      # Intel (darwin/amd64)
npm run desktop:universal  # Universal (arm64 + amd64)
npm run desktop:run        # open the built .app
```

Each build runs `desktop/build.sh`, which:
1. `expo export --platform web` → static SPA in `dist-web/`,
2. copies it to `desktop/frontend/dist/` (embedded via `//go:embed`),
3. `wails build` → `desktop/build/bin/things3-clone.app`.

The build is unsigned/ad-hoc (fine for local use). For distribution, sign +
notarize with `wails build ... -webview2 ... ` and your Developer ID.

## Layout

- `main.go` — Wails app: embeds `frontend/dist`, serves it in a WKWebView window
  with a hidden-inset title bar.
- `frontend/dist/` — the embedded web build (generated; git-ignored).
- `build.sh` — export + embed + package (takes a platform arg).

The draggable macOS title strip (clearing the traffic-light buttons) is rendered
by the app itself in `src/components/WailsTitleBar.js`, shown only when
`window.runtime` (the Wails runtime) is present — so web/iOS/Android are
unaffected.

## Windows / Linux

Wails also targets Windows and Linux from the same `main.go`. Cross-compiling
from macOS is unreliable — build on the target OS:
`wails build -platform windows/amd64` (Windows) after installing the Wails
Windows deps. (A separate, untested react-native-windows path also exists — see
`../WINDOWS-SETUP.md`.)
