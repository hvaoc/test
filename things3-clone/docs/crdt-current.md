# Current data & sync architecture (field-level LWW + HLC)

> Status: **as-shipped at tag `pre-ygo-crdt`.** This documents the system we are
> migrating *away from*. The target design is in [`crdt-ygo.md`](./crdt-ygo.md).

This app is an **offline-first CRDT** on every platform. A device never blocks on
the network: it reads and writes a local replica, and a background sync converges
that replica with the server whenever connectivity allows. Merges are automatic
and deterministic — the user is **never** asked to resolve a conflict.

## 1. One engine, four shells (the DRY spine)

There is a single canonical engine written in Go; every platform is a thin shell
around it.

```
                         ┌───────────────────────────────────┐
                         │  core/crdt  (pure Go CRDT engine)  │  ← the one source of truth
                         │  engine.go · hlc.go                │
                         └───────────────────────────────────┘
        compiled/embedded 4 ways, all speaking the same Op wire format:
   ┌──────────────┬───────────────────────┬─────────────────────┬──────────────────┐
   │ Web          │ Wails desktop         │ iOS / Android       │ pure-JS fallback │
   │ core/wasm →  │ core (native SQLite   │ mobile/mobile.go    │ src/store/crdt.js│
   │ crdt.wasm in │ store: store.go,      │ (gomobile bind of   │ + IndexedDB      │
   │ a Web Worker │ sync.go) via Wails    │ core)               │ (only if WASM/   │
   │ + SQLite-WASM│ bound methods         │                     │  Workers absent) │
   │ (OPFS)       │                       │                     │                  │
   └──────────────┴───────────────────────┴─────────────────────┴──────────────────┘
```

Relevant files:

| Concern | File |
|---|---|
| CRDT engine (registers, diff, merge, materialize) | `desktop/core/crdt/engine.go` |
| Hybrid Logical Clock | `desktop/core/crdt/hlc.go`, `desktop/core/hlc.go` |
| WASM export layer (`__crdt*` JS globals) | `desktop/core/wasm/main.go` |
| Web Worker host (WASM + SQLite-WASM/OPFS) | `public/crdt.worker.js` |
| Main-thread RPC client to the worker | `src/store/crdtClient.js` |
| Desktop/mobile native SQLite store | `desktop/core/store.go`, `desktop/core/sync.go` |
| gomobile bindings | `desktop/mobile/mobile.go` |
| Backend selector (routes per platform) | `src/store/backend.js` |
| Sync server (relay) | `desktop/server/http.go`, `desktop/server/hub.go` |
| pure-JS mirror (fallback) | `src/store/crdt.js` |

The React/React-Native app above this line is storage-agnostic: it keeps a rich
in-memory model in `TasksContext` and calls three async functions —
`loadSnapshot()`, `saveSnapshot(state)`, `sync()` — that `backend.js` routes to
the right shell.

## 2. The data model: three register types

Every entity (area, project, heading, task, customView, tag, settings) is
decomposed into **registers**, each independently mergeable. `engine.go` holds
three maps keyed by an entity key `ekey(kind, id)` = `"<kind>\x1f<id>"`:

1. **Scalar fields → Last-Writer-Wins (LWW) registers.**
   `title`, `notes`, `when`, `deadline`, `priority`, `order`, `projectId`, … Each
   is `{ value: canonicalJSON, hlc: HLC }`. On merge, the higher HLC wins.

2. **`tags` → add-wins observed-remove set.**
   The only set field (`setFields = {task: {tags: true}}`). Each element is
   `{ present: bool, hlc: HLC }`; add and remove are both HLC-stamped, so a
   concurrent add-vs-remove resolves by clock.

3. **Existence → LWW tombstone (`presence`).**
   `{ present: bool, hlc: HLC }` per entity. Create sets present=true; delete sets
   present=false. Deletes therefore converge like any other write (a resurrect
   with a higher HLC beats a delete, and vice-versa).

**Canonical JSON** (`canon`) — sorted keys, no HTML escaping — guarantees a value
written on any platform compares byte-equal on the others.

## 3. Conflict resolution: Hybrid Logical Clocks

Each register carries an **HLC** = `{ Wall int64, Ctr int64, Node string }`
(`hlc.go`). Ordering is lexicographic: wall-clock ms, then a logical counter, then
the node id as a final deterministic tie-break. This gives a **total order** over
all writes that:

- respects real time when clocks roughly agree,
- still makes progress (via `Ctr`) when two writes share a millisecond,
- is **deterministic** — every replica picks the same winner regardless of the
  order ops arrive, so replicas converge (the CRDT property).

`localStamp()` issues a new HLC for a local write; `witness(remote)` advances the
local clock past any remote HLC we observe (so subsequent local edits are
causally after it). A **drift cap** (`maxDriftMs = 5min`, mirrored in
`crdt.js` and the server's `MaxClockSkewMs`) bounds how far a bad remote clock can
push us ahead of real time — a device set to the year 2099 can't poison everyone.

**This is the "never ask the user" guarantee today:** for any single register,
one HLC is strictly greatest, so there is always exactly one winner and merge is
never ambiguous.

## 4. The op: the unit of sync

A mutation is one **Op** (identical struct in `engine.go`, `sync.go`, `crdt.js`,
server):

```go
type Op struct {
    Type  string // "field" | "set" | "presence"
    Kind  string // "task" | "project" | …
    ID    string
    Field string          // for "field" / "set"
    Elem  string          // for "set"
    Value json.RawMessage // for "field"
    Present bool          // for "set" / "presence"
    Wall  int64; Ctr int64; Node string   // the HLC
}
```

### Local write path (`ApplyLocalSnapshot`)
The app hands the engine a **whole-state snapshot**. The engine **diffs** it
against its current registers (`diff()`), emitting only the ops for what changed,
stamps each with a fresh HLC, applies them locally, and queues them in a `pending`
oplog for push. (Diffing a snapshot — rather than the app emitting granular ops —
is what lets the storage-agnostic React layer stay simple.)

### Remote merge path (`ApplyRemote`)
Pulled ops are applied iff their HLC beats the local register's; winners are
written to the register tables (never re-queued, so they don't echo back).
`witness()` advances the clock for each. Applying is idempotent and
order-independent.

### Materialize
`Materialize()` walks the present entities and rebuilds the plain-JSON app state
the UI expects.

## 5. Persistence (same shape everywhere)

Registers are stored in three SQL tables — `fields`, `setelems`, `presence` —
plus an `oplog` (unsynced local ops) and `meta` (node id, clock, pull cursor):

- **Desktop/mobile:** native SQLite (`store.go`).
- **Web:** the *same* schema in **SQLite compiled to WASM** on the **OPFS SAHPool
  VFS** (`crdt.worker.js`) — real SQLite in the browser, off the main thread.
- **Fallback:** if WASM/Workers are unavailable, the pure-JS engine (`crdt.js`)
  serializes to IndexedDB.

The engine reports the exact register rows each `Apply*` touched, so the worker
upserts only the delta instead of rewriting everything.

## 6. Sync transport (the server is a dumb relay)

`desktop/server/` is a thin, per-user **append-only op log** with token auth:

- `POST /v1/register`, `POST /v1/login` → bearer token.
- `POST /v1/push` — append this user's ops to their log. Rejects ops whose HLC is
  too far in the future (`409 ErrClockAhead`) to protect the drift cap.
- `GET /v1/pull?cursor=` — return ops after the cursor (an index), HLC-ordered.
- `GET /v1/stream` (WebSocket) — a "changed" nudge so other devices pull promptly.

The server **never merges** — it just orders and fans out ops. All CRDT logic is
in the client engine, so every device is a full replica and the system works
offline indefinitely, converging on reconnect.

## 7. What this design does *not* give us (the reasons to migrate)

1. **No collaborative text.** `notes` is a single LWW register: if two people edit
   the same note offline, the higher HLC **overwrites the other's entire text** —
   silent data loss at the character level. A team product needs character-level
   merge.
2. **Coarse list ordering.** `order` is an integer LWW field; concurrent reorders
   can collide or leave gaps. There is no real sequence CRDT.
3. **Bespoke & unaudited.** The merge algorithm, wire format, and encoding are all
   ours to maintain and prove correct. For a SaaS we'd prefer a battle-tested,
   independently-implemented, interop-checked CRDT.
4. **Snapshot-diff overhead.** Diffing whole-state snapshots is simple but O(state)
   per save; a mutation-native CRDT is O(edit).

These are exactly what the [ygo migration](./crdt-ygo.md) addresses — while
**keeping** the offline-first model, the Go-first DRY spine, the WASM+Worker web
path, and the "never ask the user" guarantee.
