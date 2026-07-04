# Shared Go data engine — desktop + mobile

The offline-first backend (embedded SQLite + cloud sync) lives in Go so a
**single implementation** powers every platform:

```
desktop/core/          the engine — SQLite store, oplog, sync (SyncAdapter + MockAdapter)
  store.go             snapshot ⇄ entity rows, diffing, load/save
  sync.go              push/pull, last-writer-wins merge, file-backed mock cloud
  store_test.go        round-trip + two-device convergence + LWW tests

desktop/main.go        Wails desktop: binds LoadSnapshot/SaveSnapshot/Sync to JS
desktop/mobile/        gomobile entry point: flat Open/LoadSnapshot/SaveSnapshot/Sync
  reactnative/         RN native modules that bridge the bound library to JS
```

The frontend never talks to SQLite directly. It keeps its in-memory model and
hands the engine whole-state **snapshots**; the engine diffs them into per-entity
changes and appends an **oplog** entry per change, which is what sync ships.

## Platform routing (`src/store/backend.js`)

| Platform        | Store                              | Cloud sync            |
|-----------------|------------------------------------|-----------------------|
| Wails desktop   | Go engine via `window.go.main.App` | mock adapter (real)   |
| iOS / Android   | Go engine via `NativeModules.Playdata` | mock adapter (real) |
| Web / other     | IndexedDB (localStorage fallback)  | local-only            |

## Building the mobile library

```bash
go install golang.org/x/mobile/cmd/gomobile@latest
gomobile init
./build-mobile.sh all      # → ../mobile-bind/{ios/Playdata.xcframework, android/playdata.aar}
```

Then register the native module for each platform:

- **Android** — copy `playdata.aar` into `android/app/libs/`, add
  `implementation files('libs/playdata.aar')`, and register `PlaydataPackage()`
  (see `reactnative/PlaydataModule.kt`).
- **iOS** — embed `Playdata.xcframework`, add `reactnative/Playdata.swift` +ﾠits
  `Playdata.m` Objective-C bridge (documented in the `.swift` header) to the
  target.

> Expo note: native modules require the bare workflow / a config plugin
> (`expo prebuild`). Managed Expo Go cannot load the `.aar`/`.xcframework`.

The JS bridge calls `Playdata.open()` once at launch (it supplies the app's
writable files dir natively), then `loadSnapshot` / `saveSnapshot` / `sync`.

## Swapping the mock cloud for a real backend

Implement `core.SyncAdapter` (Push / Pull / Name) against your HTTP or WebSocket
service and pass it to `store.SetAdapter(...)` in `main.go` / `mobile.go` instead
of `core.NewMockAdapter(dir)`. Nothing else changes — the oplog, merge, and
last-writer-wins conflict resolution stay put.
