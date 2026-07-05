# Target architecture: ygo (Yjs) CRDT engine

> Status: **in progress.** Replaces the hand-written engine documented in
> [`crdt-current.md`](./crdt-current.md). Baselined at git tag `pre-ygo-crdt`.

## 0. Why ygo, and the hard requirements

We are turning this into a **SaaS product with team collaboration**. That sets
non-negotiable requirements the current engine can't fully meet:

1. **Offline-first, long-horizon.** The app and web build must work for extended
   periods fully offline, then converge with the central database on reconnect.
2. **Bullet-proof automatic conflict resolution.** We must **never** ask a user to
   resolve a conflict — including concurrent edits to the *same rich-text note*,
   which today is silently last-writer-wins.
3. **Collaborative editing for teams** — real character-level merge for notes /
   descriptions / comments, plus presence.
4. **DRY across platforms.** One Go core for **web (WASM + Web Worker)**, **Wails
   desktop**, and **iOS/Android (gomobile)**. No re-implementing CRDT logic per
   platform.
5. **Never Yjs-the-JS-library.** Stay in Go.

**[ygo](https://github.com/reearth/ygo)** (`github.com/reearth/ygo`, v1.30.0,
maintained by reearth/Eukarya) satisfies all five:

- Pure-Go implementation of the **Yjs CRDT (YATA)** — the most battle-tested
  collaborative-editing CRDT in existence.
- **Binary-compatible with `yjs@13.x`** (lib0 encoding, y-protocols). This is our
  insurance policy: if ygo ever stalls, the wire format is Yjs's, so we can swap in
  `yrs` (Rust) or a Node Yjs server without touching stored data.
- Ships a **`mobile/`** package that is gomobile-bindable with **no CGO and no JS
  runtime**, and compiles to `js/wasm` for the browser — it slots straight into
  our existing "one Go core, four shells" spine.
- Full type set: `YText`, `YArray`, `YMap`, `YXml…`, plus **awareness** (presence),
  a **sync** protocol package, a **websocket provider**, snapshots, GC, and an
  undo manager.

Verified locally: `go get github.com/reearth/ygo/crdt@latest` → `v1.30.0`; API
below is from `go doc` on the pinned version.

## 1. How the DRY spine is preserved

The four-shell structure from the current design is **unchanged**; only the engine
inside the core changes.

```
                    ┌──────────────────────────────────────────────┐
                    │  core/ydoc  (our thin wrapper over ygo/crdt)  │
                    │  schema mapping · snapshot⇄Y.Doc · sync prims │
                    └──────────────────────────────────────────────┘
                                      │ wraps
                    ┌──────────────────────────────────────────────┐
                    │  github.com/reearth/ygo/crdt  (Yjs in Go)     │
                    └──────────────────────────────────────────────┘
   ┌──────────────┬───────────────────────┬─────────────────────┬──────────────────┐
   │ Web: core/   │ Wails desktop: core   │ iOS/Android:        │ (JS fallback is  │
   │ wasm → .wasm │ ydoc + SQLite blob    │ ygo/mobile-style    │  retired — WASM  │
   │ in Web Worker│ store, Wails methods  │ gomobile bind of    │  is required)    │
   │ + persist    │                       │ core/ydoc           │                  │
   │ Y updates    │                       │                     │                  │
   └──────────────┴───────────────────────┴─────────────────────┴──────────────────┘
```

We keep: offline-first, the Web Worker + WASM web path, SQLite/OPFS storage, and
the storage-agnostic `loadSnapshot / saveSnapshot / sync` seam in `backend.js`.

## 2. ygo API we build on (verified via `go doc`, v1.30.0)

```go
import "github.com/reearth/ygo/crdt"

doc := crdt.New(crdt.WithClientID(id))          // one replica
m   := doc.GetMap("name")                        // root shared types (public API)
t   := doc.GetText("name")                       //   created by name, outside Transact
a   := doc.GetArray("name")

doc.Transact(func(txn *crdt.Transaction) {       // all mutations inside a txn
    m.Set(txn, "title", "Buy milk")              // YMap: per-key LWW-register
    t.Insert(txn, 0, "hello", nil)               // YText: char-level sequence CRDT
    a.Insert(txn, 0, []any{"id1"})               // YArray: list CRDT (+ a.Move)
})

// --- sync primitives (offline-first exchange) ---
sv     := doc.StateVector()                       // crdt.StateVector = map[ClientID]uint64
update := crdt.EncodeStateAsUpdateV1(doc, peerSV) // everything the peer is missing
_      = crdt.ApplyUpdateV1(doc, update, origin)  // merge a remote update (idempotent)
svBytes:= crdt.EncodeStateVectorV1(doc)           // wire form of a state vector
sv2, _ := crdt.DecodeStateVectorV1(svBytes)
merged, _ := crdt.MergeUpdatesV1(u1, u2, …)        // compact many updates into one
```

Also available: `sync` (y-protocols handshake: `EncodeSyncStep1/2`,
`ApplySyncMessage`, `ReadSyncMessage`), `provider/websocket` (a room server with
auth + persistence adapters), awareness for presence, and `doc.OnUpdate(fn)` to
capture every produced update for persistence/broadcast.

**Design constraint discovered:** detached nested shared types (a `YMap` inside a
`YMap`) are constructed via internal fields in ygo v1.30.0 and are **not** part of
the stable public API. Root accessors `doc.GetMap/GetText/GetArray(name)` **are**.
So our schema uses **namespaced root types**, not deep nesting (§3).

## 3. Document schema — how the domain maps onto ygo

One `crdt.Doc` per **sync scope** (see §6 for granularity). Within it, every entity
is addressed by namespaced **root** shared types:

| Domain concept | ygo representation | Merge behavior |
|---|---|---|
| Entity existence / index | root `YMap "index"`, key `"<kind>:<id>"` → `true` | key present = alive; `Delete` = tombstone (Yjs keeps a delete marker) |
| Entity scalar fields (title, when, deadline, priority, order, projectId, …) | root `YMap "<kind>:<id>"`, one key per field → JSON-scalar `any` | **per-field LWW** — same guarantee as today, now Yjs-native |
| Task **notes** (and future descriptions/comments) | root `YText "note:<id>"` | **character-level YATA merge** — the headline win; no more clobber |
| Task **tags** | keys of root `YMap "tags:<id>"` (`tag → true`) | add-wins-ish; concurrent add/remove converge |
| **Ordering** within a project/area | *Phase 1:* the existing integer `order` field (LWW) rides the generic field path. *Phase 2:* root `YArray "order:<containerId>"` of child ids, using `YArray.Move` | Phase 2 gives true concurrent-reorder safety |
| Settings | root `YMap "settings"` | per-key LWW |

Rationale:
- **Per-field YMap keys**, not one JSON blob per entity, so two devices editing
  *different fields of the same task* both survive (blob-LWW would lose one).
- **notes as its own root YText** keeps collaborative text isolated and cheap, and
  sidesteps the nested-type limitation.
- Deleting an entity = `index.Delete("<kind>:<id>")` (+ optionally clearing its
  field map). Materialize skips anything not present in `index`.

### The snapshot⇄Y.Doc bridge (keeps the app layer untouched)
The React app still hands whole-state snapshots to storage. `core/ydoc` provides:

- `ApplyLocalSnapshot(stateJSON)` — **diffs** the incoming app state against the
  current `Doc` materialization and applies the minimal Y-ops in one `Transact`:
  changed field → `YMap.Set`; changed note → a **prefix/suffix string diff** turned
  into `YText.Insert`/`Delete` (so edits merge instead of replace); added/removed
  tag → `YMap.Set`/`Delete`; new/removed entity → `index` update.
- `Materialize()` — rebuilds the plain-JSON app state from the `Doc`.

This mirrors today's `engine.go` diff/materialize seam, so **`backend.js`,
`TasksContext`, and every component stay byte-for-byte the same**. Later phases can
introduce granular mutations (calling `YText.Insert` directly from the editor) for
O(edit) instead of O(state) writes, once the bridge is proven.

## 4. Offline-first sync protocol

Two devices (or device↔server) reconcile with a **state-vector diff exchange** —
the standard Yjs two-step, which is inherently offline-tolerant and idempotent:

```
A → B :  svA = EncodeStateVectorV1(docA)          // "here's what I have"
B → A :  updB = EncodeStateAsUpdateV1(docB, svA)   // "here's everything you're missing"
A     :  ApplyUpdateV1(docA, updB, nil)            // merge; converges
         (symmetric the other direction)
```

- **No cursors, no per-op log required for correctness.** A device offline for a
  month sends its state vector on reconnect and receives exactly the missing
  updates — regardless of how many edits happened on either side.
- **Idempotent & commutative.** Applying the same update twice, or in any order, is
  a no-op after the first — the CRDT property, now provided by Yjs/YATA rather than
  our HLC comparisons.
- **Bullet-proof, prompt-free by construction.** YATA gives a single deterministic
  convergent state for *every* concurrent edit, including interleaved characters in
  the same note. There is no code path that can surface a conflict to the user.

## 5. Persistence

We persist **Yjs updates**, not register rows:

- On every local transaction, `doc.OnUpdate(fn)` yields a compact binary update.
  Append it to an `updates` table (SQLite native on desktop/mobile; SQLite-WASM on
  OPFS in the browser — **same storage substrate as today**).
- Periodically **compact**: `MergeUpdatesV1(all…)` → one snapshot update; also
  `RunGC(doc)` to collect deleted items. Store the merged blob + truncate the log.
- On load: replay the merged snapshot + tail updates into a fresh `Doc`
  (`ApplyUpdateV1`). The device `ClientID` is persisted so identity is stable.

The `meta` table keeps `clientID` and the server sync checkpoint.

## 6. Server: from op-relay to Yjs sync

> **Implemented:** `desktop/server/ysync/` + `desktop/cmd/ysync-server`. It is a
> multi-tenant Yjs relay — **one authoritative `crdt.Doc` per tenant** (a tenant
> is a collaborating team), tenants fully isolated. Endpoints: `POST /v1/push`
> `{update}`, `POST /v1/pull` `{sv}` → `{update, version}` (state-vector diff),
> `GET /v1/stream` (WebSocket change-nudge), `GET /v1/health`. Auth and
> persistence are seams: `Authenticator` (Phase-1 `DevAuth` stub — token
> `"tenant:user"`) and `Persistence` (`MemPersistence` / `FilePersistence`,
> atomic per-tenant snapshot). The server is **domain-agnostic** — it merges
> opaque updates, so it shares the CRDT but needs none of the schema. Tested:
> same-tenant team merge (no clobber), cross-tenant isolation, restart
> persistence, auth-required. Sharding one Doc per tenant → per project later is a
> one-line `ScopeFunc` change.

The current (old) server is a per-user append-only **op** log; the new one is a
per-scope **Yjs update** relay. Two viable routes, both pure Go:

- **Reuse `ygo/provider/websocket`** — a room server with `AuthFunc`/`Authorize`
  hooks (we already do token auth), persistence adapters, and read-only conns for
  view-only team members. Rooms map to sync scopes.
- **Keep our thin HTTP+WS server** and swap the payload: `/v1/push` appends
  updates, `/v1/pull?sv=` returns `EncodeStateAsUpdateV1(scopeDoc, clientSV)`, the
  WS pushes new updates. The server holds an authoritative `Doc` per active scope.

### Sync scope & access control (the SaaS decisions)
- **Scope = one `Doc` per team workspace or per project/board.** This is the unit
  of sharing, permission, and server memory. Recommendation: **per project**,
  lazy-loaded, snapshotted, and evicted when idle.
- `ClientID` is collision-avoidance, **not** auth (ygo says so explicitly).
  Authorization stays at the transport: a token grants access to specific scopes;
  `Authorize` downgrades non-editors to read-only.
- **Horizontal scale:** multiple server instances serving the same scope need a
  pub/sub fan-out (Redis) so an update on node A reaches subscribers on node B.
  Plan for it before it's needed.
- **Presence:** ygo awareness (cursors, who's-online) rides the same WS.

## 7. Migration plan (phased, low-risk)

The binary-compat wire format is the safety net; we roll out in slices, each
shippable and reversible.

- **Phase 0 — Foundations (this PR).** Add ygo dep. Build `core/ydoc`: schema,
  `ApplyLocalSnapshot`/`Materialize` bridge, sync primitives, and Go tests proving
  (a) offline convergence and (b) **concurrent same-note edits merge** (no
  clobber). No app wiring yet. ✅ engine proven in isolation.
- **Phase 1 — Swap the engine under the bridge. ✅ Done, all four platforms.**
  Web runs the ygo engine in the WASM worker (`core/wasm/ydoc_exports.go`),
  persisting a Yjs snapshot blob in SQLite/OPFS; desktop (Wails) and mobile
  (gomobile) run it via `core/ydstore` (Yjs blob file + state-vector sync). All
  sync through the ysync server with the identical protocol. The app layer and
  `backend.js` seam are unchanged. A one-time, safe-fallback migration seeds the
  ygo doc from the old register tables on the web. Verified: browser create→persist
  →reload→server round-trip; `go test ./core/ydstore` two-device convergence +
  no-clobber note merge.
- **Phase 2 — Real auth ✅ + collaborative-notes/ordering (remaining).**
  *Done:* real accounts (`server/auth`) — bcrypt users, tenants (teams), per-tenant
  roles (owner/editor/viewer), session + tenant-scoped sync tokens; push is
  owner/editor-only (viewers 403). Client `authenticate()` logs in / auto-registers,
  opens a tenant, mints a sync token. Verified by `go test ./server/auth` and a live
  browser sign-in→sync. *Remaining:* wire the notes editor to `YText` directly
  (granular ops + awareness cursors) instead of round-tripping strings; ordering →
  `YArray` (concurrent-reorder safety) — both enhancements, not correctness gaps.
- **Phase 3 — Server + multi-tenant.** ✅ Core built early (`server/ysync`):
  per-tenant Doc, tenant isolation, push/pull state-vector sync, WS nudge,
  pluggable auth + persistence. Remaining: real auth (Phase 2), Redis fan-out for
  multi-instance scale, snapshot/GC/eviction, and ordering → `YArray`.

## 8. What we explicitly keep vs. replace

| Keep | Replace |
|---|---|
| Offline-first; local-first reads/writes | Hand-written LWW/HLC merge → **ygo/YATA** |
| Go-first "one core, four shells" spine | HLC + op wire format → **Yjs updates + state vectors** |
| Web = WASM in a Web Worker | Snapshot-diff-only writes → (later) granular Yjs ops |
| SQLite / OPFS storage substrate | Register-row tables → **Yjs update log + snapshots** |
| Token auth; realtime WebSocket nudge | Op-relay server → **per-scope Yjs sync server** |
| "Never ask the user" guarantee | LWW-clobbered notes → **character-level merge** |
