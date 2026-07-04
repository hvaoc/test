# Shared Go data engine — desktop + mobile

The offline-first backend (embedded SQLite + cloud sync) lives in Go so a
**single implementation** powers every platform:

```
desktop/core/          the engine — SQLite store, field-level CRDT, sync
  hlc.go               Hybrid Logical Clock (skew-tolerant, causal, tie-broken)
  store.go             snapshot ⇄ per-field CRDT registers, diff/materialise
  sync.go              push/pull, deterministic CRDT merge, file-backed mock cloud
  store_test.go        round-trip + concurrent-field / tag-merge / LWW tests

desktop/main.go        Wails desktop: binds LoadSnapshot/SaveSnapshot/Sync to JS
desktop/mobile/        gomobile entry point: flat Open/LoadSnapshot/SaveSnapshot/Sync
  reactnative/         RN native modules that bridge the bound library to JS
```

The frontend never talks to SQLite or CRDTs directly. It keeps its in-memory
model and hands the engine whole-state **snapshots**; the engine diffs each into
**per-field CRDT operations** and appends them to an **oplog**, which is what
sync ships.

## Conflict resolution — automatic & convergent

Every register is versioned independently and stamped with a Hybrid Logical
Clock, instead of versioning whole entities:

- **Scalar fields** (title, when, deadline, priority, order, notes, the whole
  `query` / `checklist` value) → **LWW registers**. Concurrent edits to
  *different* fields of the same task both survive; same-field edits resolve to
  the higher HLC — the same winner on every device.
- **`tags`** → **add-wins set CRDT**: concurrent tag additions on two devices all
  survive.
- **Existence** → an LWW tombstone register, so create/delete races resolve
  deterministically.

HLCs make ordering causal and clock-skew-tolerant (a fast device clock can't win
everything), and the node id is a deterministic tie-break — so all replicas
**converge to the same state regardless of sync order**. That is the property
that makes this safe for multi-device *and* multi-user. Web (IndexedDB) is a
local-only blob store; the CRDT guarantees apply on the Go-backed platforms.

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
