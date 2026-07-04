# Data layer — offline-first, multi-user, multi-platform

Every platform is a **first-class CRDT replica**: it holds all data locally,
works fully offline, and converges with every other device through a sync
server. The field-level CRDT is written **once in Go** and runs everywhere — the
SQLite-backed `core` on desktop/mobile, and the SQLite-free `core/crdt`
**compiled to WASM** and run in a Web Worker in the browser. All three speak the
same op format / Hybrid Logical Clock / canonical JSON, so a browser tab, a Mac
app, and a phone all merge each other's edits correctly. (`src/store/crdt.js` is
a pure-JS fallback used only if WASM/Workers are unavailable.)

```
desktop/core/          Go engine — SQLite store, field-level CRDT, sync
  hlc.go               Hybrid Logical Clock (skew-tolerant, causal, tie-broken)
  store.go             snapshot ⇄ per-field CRDT registers, diff/materialise
  sync.go              push/pull, deterministic CRDT merge, file-backed mock cloud
  httpadapter.go       SyncAdapter over HTTP → the real sync server
  store_test.go        round-trip + concurrent-field / tag-merge / LWW / canon tests
desktop/core/crdt/     SQLite-free pure-Go CRDT engine (compiles to js/wasm)
desktop/core/wasm/     syscall/js entry point → crdt.wasm (built by build-wasm.sh)

public/                served at the web root by Expo
  crdt.wasm            the Go engine compiled to WASM
  wasm_exec.js         Go's WASM JS loader
  crdt.worker.js       Web Worker: runs the WASM engine + owns IndexedDB
src/store/crdtClient.js  main-thread RPC client to the worker
src/store/crdt.js        pure-JS fallback engine (only if WASM unavailable)

desktop/server/        multi-user sync server — token auth, per-user op log,
                       push/pull, realtime WebSocket. A thin, dumb relay: all
                       merge happens in the clients.
desktop/cmd/server/    runnable server binary
desktop/main.go        Wails desktop: binds LoadSnapshot/SaveSnapshot/Sync to JS
desktop/mobile/        gomobile entry point: flat Open/LoadSnapshot/SaveSnapshot/Sync
  reactnative/         RN native modules that bridge the bound library to JS

src/store/crdt.js      JS mirror of the Go CRDT (the web replica)
src/store/backend.js   platform routing + web IndexedDB persistence + server sync
```

## Running the sync server

```bash
cd desktop
go run ./cmd/server -addr :8090 -data ./sync-data.json   # -data optional
```

- **Web**: Settings → Sync → sign in (URL `http://localhost:8090`).
- **Desktop/mobile**: set `THINGS_SYNC_URL` (+ `THINGS_SYNC_TOKEN`) so the Go
  store uses `HTTPAdapter` instead of the file-backed mock.

The server never merges — it authenticates, keeps a per-user append-only op log,
serves ops since a cursor, and fans out realtime nudges. Correctness comes from
every client running the identical CRDT.

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
that makes this safe for multi-device *and* multi-user, and it holds on **every**
platform including the browser (the JS CRDT mirrors the Go one byte-for-byte;
`TestCanonCompat` pins the shared canonical-JSON contract).

## Platform routing (`src/store/backend.js`)

| Platform        | Local store (CRDT replica)                       | Cloud sync            |
|-----------------|--------------------------------------------------|-----------------------|
| Wails desktop   | Go engine via `window.go.main.App`               | HTTP server / mock    |
| iOS / Android   | Go engine via `NativeModules.Playdata`           | HTTP server / mock    |
| Web             | Go engine as **WASM** in a Worker + IndexedDB    | HTTP server (sign-in) |
| Web (fallback)  | pure-JS `crdt.js` + IndexedDB                     | HTTP server (sign-in) |

Rebuild the browser engine after changing `core/crdt`:

```bash
cd desktop && ./build-wasm.sh   # → public/crdt.wasm + wasm_exec.js
```

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
