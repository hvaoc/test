# Architecture: local-first at 1,000,000 tasks

Status: **accepted, implementation in progress** (Phase 0–1 + the three-scope split
of Phases 4–6 done; record-layer write path + Postgres tier remain — see §8)
Scope: the offline data + sync core across four tiers — web (`sqlite.wasm`/OPFS),
desktop (Wails) and mobile (gomobile) on native SQLite, and the server on Postgres —
all behind one storage port (§5.1) speaking one field-level op wire-format.

This document is the source of truth for the re-architecture. Every decision here
is justified against a hard target: **a single workspace with 1,000,000 tasks,
fully usable offline — create, edit, search, filter, reorder — that syncs back
losslessly when the network returns.** If a design choice doesn't survive that
number, it isn't in this document.

---

## 1. Why the current model can't reach 1M

Today the entire workspace — every task, project, area, tag, ordering, and the
settings singleton — is **one CRDT unit of work**. All three platforms run the
**same ygo (Yjs-in-Go) whole document**, state-vector-synced to one per-tenant Yjs
document on the server:

- **Web (WASM):** `core/ydoc` via `core/wasm/ydoc_exports.go`, persisted to
  IndexedDB.
- **Desktop (Wails) & mobile (gomobile):** the same `core/ydoc` engine via
  `core/ydstore`, persisted to a JSON file (`store.ydoc.json`) — **not** SQLite.
- **Server:** `server/ysync` holds one Yjs doc per tenant; sync is
  `/v1/pull {sv}` → `{update, sv}` then `/v1/push {update}`; WebSocket carries
  `changed` nudges + `presence`.

A field-level SQLite CRDT (`core/store.go`) and its WASM twin (`core/crdt`) already
exist in the tree — LWW registers + HLC + oplog — but are **dormant legacy** from
before the ygo migration, instantiated nowhere on a live path. The migration moved
*away* from that scalable field-CRDT toward the whole-document ygo model to gain
collaborative text. Reviving it as the record layer (§3) is most of Phase 1.

That "the dataset is the unit" choice is the ceiling. Concretely, at 1M:

| Cost | Mechanism | At 1M |
|---|---|---|
| Memory | a CRDT holds every item + its metadata resident | ~0.3–1.5 GB → web WASM (≤4 GB address space) OOMs; mobile heaps thrash |
| Startup | decode the whole doc / `SELECT *` + materialize one JSON | seconds |
| Search | linear scan of the in-memory array per keystroke | 100–500 ms → visible jank |
| Sync diff | state-vector / full-view diff is O(document) | grows with the dataset, not the change |

The comparison that names the mistake: **Google Docs / Dropbox Paper make one
*document* the CRDT unit** — a naturally bounded thing you load on open. We made
the *whole account* the unit, which grows without bound. We are, in effect, using
a CRDT document as a database. CRDTs are for bounded, collaboratively-edited
documents; databases are for unbounded collections of records.

**The single lever: choose a bounded unit of work.**

---

## 2. Target architecture — two layers, three scopes

### 2.1 Two layers

**Record layer (the database).** Tasks, projects, areas, tags, headings, and all
their *structured fields* (title, dates, priority, completion, tags, **ordering**)
are **rows in SQLite**, each field an independently-versioned CRDT register
(LWW + Hybrid Logical Clock), exactly as `core/store.go` already models them. This
layer never loads the whole workspace: it answers **queries** (this view, this
project, this search — paged) and writes **per entity**. This is what makes 1M
storage, search, and filter work with bounded memory.

**The search model** (decided):
- **Title** is the only full-text field, via a SQLite **FTS5** index using the
  default tokenizer → **word-prefix** matching (typing `rep` finds "Quarterly
  **Rep**ort"). The index exists solely so a title search is O(log n) instead of an
  O(n) `LIKE '%…%'` scan of a million rows.
- **Notes are NOT searchable.** They are not in the FTS index and are not copied
  into the record layer for search — they live only in the per-task ygo document
  (below). This keeps the index small and means notes edits never touch it.
- **Every other field** (priority, dates, tags, project, completion, …) filters
  with **indexed SQL comparison operators** — `=`, `!=`, `<>`, `>`, `<`, `>=`,
  `<=`, `IN`, `NOT IN` — *not* FTS. Fields are whitelisted (unknown field → error),
  so filters are injection-safe. This mirrors the operator model `query.js` already
  uses on the frontend.

> **Future option — substring/contains search.** If word-prefix proves too strict
> (e.g. matching "p**rep**aration"), swap the title FTS tokenizer to `trigram`:
> `CREATE VIRTUAL TABLE tasks_fts USING fts5(id UNINDEXED, title, tokenize='trigram')`.
> That gives fast indexed `LIKE`/substring matching at 1M, at the cost of a larger
> index (trigrams of the title). It is a one-line tokenizer change plus a reindex;
> no schema or query-shape change. True typo-tolerant fuzzy (subsequence) is *not*
> indexable and is deliberately out of scope at 1M.

**Text layer (the documents).** The *rich-text fields that need character-level
collaboration* — a task's **notes/description** — are each a **small ygo document**
(a blob), loaded **only when that task's editor is open**. This is the only place
the whole-document CRDT model is used, and it is always tiny (one task's notes).
Live cursors and character-merge live here. This is the "Google Doc unit."

The rule that classifies every piece of data:

> **Anything the list can display is a record-layer field and syncs to everyone.
> Only free-text notes live in a per-task document, loaded on open.**

So: completion, title, dates, priority, tags, ordering → record layer, always
live for list-viewers. Notes body → per-task ygo doc, loaded on open, collaborative
for whoever is inside that task.

### 2.2 Three sync scopes

Routing is decided by which scope a change belongs to:

| Scope | Unit | Synced to | Examples |
|---|---|---|---|
| **Tenant / shared** | record-layer rows (field ops) | all workspace members | tasks, projects, areas, completion, dates, priority, tags, **task order in a list** |
| **Tenant / shared, on-demand** | per-task ygo document | members who open that task | notes rich text, live cursors |
| **User / private** | per-user prefs (field ops) | that one user's devices only | settings, theme, **sidebar order (if personal)** |

The **user scope** is new and exists specifically to satisfy: *settings are
per-user — never shared with teammates, but they must sync across the same user's
own devices (web ↔ desktop ↔ mobile).* The server routes a user-scope delta only
to sessions belonging to that user; it never enters the tenant broadcast.

> **This also fixed a correctness bug (now resolved).** Settings previously lived in
> the shared `settingsRoot` map of the tenant ygo document, so changing a setting
> *propagated to teammates* — the opposite of the requirement. Settings now live in a
> separate per-user scope (`core/ydoc` settings doc → server room `u:<userId>`), so a
> setting change never reaches another user. Verified by `TestSettingsAreUserPrivate`
> (ydstore, end-to-end through the server) and `TestSettingsScopeIsolation` (ydoc).

---

## 3. The record layer at 1M — the query-oriented API

The existing CRDT semantics (LWW registers, add-wins sets, presence tombstones,
HLC, oplog) are **kept as-is** — they're correct and already cross-platform
byte-compatible. What changes is the **shape of the API**, because
`SaveSnapshot`/`LoadSnapshot` (whole-workspace) is the thing that doesn't scale.

**Reads become queries, not materializations.** New store methods return only what
a screen shows, backed by indexes:

- `QueryTasks(q)` — tasks matching operator conditions (`=`/`!=`/`<>`/`>`/`<`/`>=`/
  `<=`/`IN`/`NOT IN` over whitelisted fields), ordered by `rank, id`, limited/paged.
  Backed by SQLite indexes on `projectId`, `when`, `completed`, and `rank`.
- `SearchTasks(text, q)` — FTS5 word-prefix `MATCH` over the **title only**,
  intersected with the same operator conditions. Offline, bounded memory.
- `GetTask(id)` — one entity, for the detail view.
- Counts for badges via indexed `COUNT`, never by loading rows.

**Writes become per-entity, not whole-snapshot diffs.** `SetField(kind,id,field,
value)`, `ToggleComplete(id)`, `Move(id, beforeId, afterId)` (computes a fractional
rank between neighbors), `AddTag/RemoveTag`, `Create/Delete`. Each emits exactly
the ops it changed into the oplog — O(change), not O(dataset).

**Indexes / FTS are a derived read-model.** The CRDT registers remain the source
of truth; a shredded, indexed projection (real columns + FTS5) is maintained in the
same transaction as each apply, so queries hit indexes while merge stays register-
based. It's rebuildable from the registers, so it's disposable.

**The frontend stops holding the whole workspace.** Lists are virtualized (already
true — `DraggableVirtualTaskList`) and now backed by paged queries + live deltas:
when a delta arrives for an entity in the current view, patch that row. Search runs
in the worker/store, never on the render thread.

### Ordering (Area / Project / Task position)

Position is a **fractional-index field on the record**; a reorder is **one field
write on one row**, syncs as a normal record delta, and re-sorts for list-viewers
live — same path as completion. Concurrent moves resolve by LWW on the rank with a
deterministic id tie-break. (A workspace-wide `YArray` of ids is explicitly
rejected: it is itself a single ever-growing structure — the monolith antipattern
at a different address.)

**Precision fix required for 1M.** `store/ordering.js` today keys `order` as a
**float64** subdivided by `(prev+next)/2`, with a `prev+1` fallback when a gap gets
too tight. Doubles exhaust after ~50 consecutive inserts into the same gap — fine
today, not at 1M under heavy reordering (the fallback silently degrades ordering).
Phase 2 moves ranks to **lexicographic string keys** (fractional-indexing /
LexoRank style) which subdivide indefinitely and never need a global relabel, or
adds background rebalancing. Ranks stay a plain field either way, so the CRDT/sync
path is unchanged.

Shared vs personal:
- **Task order inside a shared list** → shared (record layer, tenant scope).
- **Area/Project sidebar order** → product decision. If teammates share one
  arrangement → tenant scope. If each user arranges their own → **user scope**
  (moves next to settings). Default here: **shared**, revisited in Phase 2.

---

## 4. Sync protocol & routing

The field-op push/pull already implemented (`oplog`, HLC, cursor, pending queue,
peek/drop for crash-safety) is the record-layer transport. Changes:

1. **Scope tag on every op stream.** A push carries `{scope: tenant|user, tenantId
   | userId, ops[]}`. The server appends to the matching per-scope log and
   **routes**: tenant → fan out to workspace members; user → fan out only to that
   user's other sessions.
2. **Push over WebSocket, not nudge-then-pull.** Today data is a WS nudge followed
   by an HTTP pull (a beat behind). Record deltas are small; push them on the WS so
   list-viewers update instantly (this is the "push-based realtime" item).
3. **Per-task documents sync on open.** Opening a task subscribes to its ygo doc
   room (state-vector sync + awareness/cursors); closing unsubscribes. Never loaded
   in bulk.
4. **Offline is lossless at 1M because only changes travel.** A workspace with 1M
   tasks and 40 offline edits syncs 40 ops on reconnect, not a million. Convergence
   is guaranteed: field ops are commutative under LWW/HLC, so push-local +
   pull-remote + apply always converges with no user conflict resolution.

---

## 5. Storage: one port, per-tier adapters

### 5.1 The storage port

Everything above the data layer — views, lists, search, the UI — codes against a
single **`RecordStore` port**, never a concrete engine. It never knows whether it
is talking to SQLite, `sqlite.wasm`, or Postgres.

```
        app / UI / views  (engine-agnostic)
                 │
        RecordStore  (port: QueryTasks, SearchTasks, GetTask, CreateTask,
                 │    SetTaskField, ToggleComplete, MoveTask, AddTag/RemoveTag,
                 │    DeleteTask, ApplyRemote, PendingOps, MarkSynced …)
     ┌───────────┼───────────────────────────┐
 native adapter        web adapter              server adapter
 Go + modernc SQLite   JS + sqlite.wasm/OPFS    Go + Postgres
 (desktop, mobile)     (browser worker)         (cloud, multi-tenant)
```

All adapters speak the **same field-level op wire-format** (LWW + HLC), so they
interoperate regardless of the engine underneath. The UI seam already exists today
(`crdtClient` → worker RPC); Phase 2 widens it to the full query API.

### 5.2 The adapters

| Tier | Record engine | Storage | Runs in | Role |
|---|---|---|---|---|
| Desktop (Wails) | Go (`core/record`) | native SQLite (`modernc.org/sqlite`) + FTS5 | app process | offline UI + local queries |
| Mobile (gomobile) | Go (`core/record`, same code) | native SQLite + FTS5 | app process | offline UI + local queries |
| Web | **JS record adapter** | **official `sqlite.wasm` + OPFS VFS** | **dedicated Worker** | offline UI + local queries |
| Server | Go (`core/record` semantics) | **Postgres** | cloud | durable multi-tenant hub, auth, onboarding, server-only queries |

The **text layer** (per-task ygo notes doc) is the same everywhere: loaded on open,
synced by state-vector; blobs persisted per adapter (SQLite/OPFS on clients,
Postgres on the server).

### 5.3 Web adapter — decided

The web record layer uses the **official `sqlite.wasm` with its built-in OPFS VFS**,
driven by **JavaScript in a dedicated Worker**, behind the `RecordStore` port.

- **Why not compile the Go engine to WASM?** That path (Go + `modernc` → WASM) would
  force us to **write and own a custom OPFS VFS** to persist/page from disk — the
  exact SQLite/VFS/OPFS plumbing we explicitly do *not* want to own. `sqlite.wasm`
  ships that VFS, maintained by the SQLite team; we consume it as a blackbox.
- **Why JS drives it:** `sqlite.wasm` is C compiled to WASM with a **JS API**. A
  Go-WASM module is a separate module with its own memory and can't call it except
  through an awkward per-query JS bounce — so nobody does that. Driving it from JS is
  the intended, first-class path.
- **Cost we accept:** the record layer's SQL-driving glue is written **twice** — Go
  on native, JS on web. But the SQL statements, the schema, the CRDT semantics, and
  the op wire-format are **shared by design**; only the thin glue (+ ~30 lines of
  HLC) is duplicated. Native (Go) and web (JS) remain protocol-compatible.
- **Memory stays bounded at 1M** because the OPFS VFS keeps the database as an
  on-disk OPFS *file* and pages it in on demand — SQLite never loads the whole DB
  into WASM memory, so the ~4 GB WASM ceiling is a non-issue. Indexed queries and
  title FTS touch a handful of pages regardless of table size.
- **All query execution runs in the Worker**, never the UI thread. The UI posts a
  request and renders the rows that return.
- **Single-owner across tabs.** A Web Lock (or SharedWorker) elects one tab to own
  the OPFS handles; other tabs proxy to it. The replica is disposable/rebuildable
  from the op-log + server, so contention or corruption is recoverable, never fatal.
  This removes the three conditions that made the earlier `createSyncAccessHandle`
  crash fatal (authoritative blob · exclusive handle · no coordination).

**Measured in-browser (Phase 3 proof, `public/sqlite-bench.html`).** `sqlite.wasm`
+ OPFS in a Worker, page cache **pinned at 2 MB** while the OPFS database holds the
rows on disk:

| tasks | edit | query | FTS search |
|---:|---:|---:|---:|
| 100k | 13.6 ms | 11.8 ms | 5.7 ms |
| **1M** | **19.0 ms** | **23.2 ms** | **14.5 ms** |

Latency barely moves from 100k → 1M though the database is **300×+ larger than the
cache** — so memory is bounded by the working set, not the dataset, exactly as on
native. Absolute numbers are higher than native Go (sub-ms) because each cache miss
is an OPFS read, but they are an order of magnitude inside "instant" and run in the
Worker, off the UI thread.

**Learnings that harden the code on _every_ tier:**
1. **Single-owner is mandatory, and crash recovery is slow.** A Worker killed
   mid-transaction held its OPFS SAHPool handles for **>60 s** before the browser
   released them. So: elect one owner via a Web Lock and hand off gracefully; never
   spawn a competing worker; and for the abrupt-crash case, recover by acquiring a
   **fresh pool** rather than busy-waiting on the wedged handles.
2. **Indexes must cover the actual view queries, and run `ANALYZE`.** Without a
   composite `(projectId, completed, rank)` index + stats, SQLite full-scanned and a
   list query took **235 ms**; with them it dropped to **7 ms**. This index design
   applies identically to the native Go store — same queries, same indexes.
3. **Bulk import must be set-based.** A per-row JS→WASM insert loop capped at
   ~1k rows/s; generating rows inside SQLite (a recursive CTE / `INSERT … SELECT`)
   seeded 1M in seconds. The initial-sync/hydrate path on all tiers should import in
   bulk, not row-by-row.
4. **Bounded memory is a `cache_size` guarantee, not luck** — pin the steady-state
   page cache small; use a large cache only transiently during import.
5. **Monotonic (zero-padded) ids** give sequential primary-key locality, avoiding
   random-write thrash during large imports.

> IndexedDB remains **only** the transitional home for today's whole-document ygo
> blob (it fixed that crash). It is not the record-layer store.

### 5.4 The server tier — record engine on Postgres

The server is **another replica of the record layer**, backed by Postgres instead
of SQLite. Because the record layer is storage-agnostic (just LWW registers + HLC +
an op-log), the server reuses the **same CRDT semantics, op wire-format, and query
shapes** — its SQL is written in the Postgres dialect (`ON CONFLICT`, `tsvector`,
`BIGSERIAL`), but the design is identical.

```
  Native client ──ops──┐
                       ├──►  Sync server (Go record engine)  ──►  Postgres
  Web client   ──ops──┘        multi-tenant · durable · authoritative
```

**What Postgres does:**
1. **Durable, multi-tenant op-log + optional materialized state.** Every pushed op
   lands here (append-only, per tenant/scope). This is the source of truth for
   *durability* and for *onboarding* — a new device pulls a snapshot + recent ops
   from here instead of replaying all history.
2. **The account system** — users, tenants, memberships, invites, roles, sessions,
   billing (the `auth` store's production home).
3. **Server-only queries a client structurally can't run** (a client holds only its
   synced subset): analytics, admin, cross-user reporting, integrations/webhooks,
   and server-side full-text (Postgres `tsvector`) over a whole tenant.
4. **Holds the notes ygo blobs** (text layer) per tenant, synced by state-vector.

**What Postgres does NOT do:**
- It **is never in the offline path.** Offline, the app reads/writes only the local
  SQLite/OPFS replica and queues ops; Postgres is touched only when online, to sync.
  Rendering a list never waits on Postgres.
- It **does not run the UI's queries.** "Show me today's tasks" hits the *local*
  engine; Postgres answers *sync* and *server-only* queries.

**Minimal Postgres sync schema** (the server can be far leaner than a client — the
materialized projection and server FTS are add-ons, built only when server-side
queries are needed):

```sql
-- append-only op-log, the durable sync spine
CREATE TABLE ops (
  seq        BIGSERIAL PRIMARY KEY,          -- global order for pull cursors
  tenant_id  TEXT NOT NULL,
  scope      TEXT NOT NULL,                  -- 'tenant:<id>' | 'user:<id>' (see §2.2)
  optype     TEXT NOT NULL,                  -- 'field' | 'set' | 'presence'
  kind       TEXT NOT NULL, entity_id TEXT NOT NULL,
  field      TEXT, elem TEXT, value TEXT, present BOOLEAN,
  hlc        TEXT NOT NULL,                  -- wall.ctr.node
  actor      TEXT NOT NULL                   -- user id, for authz/audit
);
CREATE INDEX ops_pull ON ops (tenant_id, scope, seq);

-- per-task notes document (text layer), one Yjs blob per task
CREATE TABLE note_docs (
  tenant_id TEXT NOT NULL, task_id TEXT NOT NULL,
  state     BYTEA NOT NULL,                  -- Yjs full-state update
  PRIMARY KEY (tenant_id, task_id)
);

-- accounts / teams (the auth store's production tables) — sketch
CREATE TABLE users        (id TEXT PRIMARY KEY, email TEXT UNIQUE, pass_hash TEXT, verified BOOLEAN, created TIMESTAMPTZ);
CREATE TABLE tenants      (id TEXT PRIMARY KEY, name TEXT, created TIMESTAMPTZ);
CREATE TABLE memberships  (tenant_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (tenant_id, user_id));
```

Push = append rows to `ops` (+ fan out); pull = `SELECT … FROM ops WHERE tenant_id=?
AND scope=? AND seq > ?`. Routing by `scope` gives the tenant-vs-user fan-out of
§2.2. An optional materialized `tasks` projection (same columns as the client
read-model, in Postgres) backs server-side queries and fast new-device snapshots.

---

## 6. The trade we are choosing deliberately

The two-layer split trades **whole-workspace character-level collaboration** for
**database scale + offline SQL search**. Cross-task realtime becomes "field deltas
stream in" (rows update live) rather than "one shared document"; character-level
co-editing with cursors remains, scoped to whichever task's notes people are inside.
For a task app that is the right trade. We are choosing it with eyes open.

---

## 7. Prove-the-wall (validation gate)

`cmd/loadtest` drives the live `core/ydoc` engine at increasing task counts and
measures heap, snapshot size, load/materialize time, and — critically — the cost of
a **single-field edit** under the current whole-state bridge.

**Measured baseline (current whole-doc ygo model, notes≈40 chars/task):**

| tasks | heap | snapshot | load | materialize | 1-field edit |
|---:|---:|---:|---:|---:|---:|
| 10k | 74 MB | 3.6 MB | 103 ms | 59 ms | 74 ms |
| 100k | 734 MB | 38 MB | 1.17 s | 707 ms | **746 ms** |
| 250k | 1.8 GB | 96 MB | 2.85 s | 1.96 s | **1.99 s** |
| 500k | 3.6 GB | 194 MB | 5.9 s | 4.5 s | **4.1 s** |

The curve is dead-linear at **~7.3 KB resident heap per task**. Conclusions that
drive this document:

- **Web (wasm32, ≤4 GB address space) OOMs at ~400–500k tasks.** 1M ≈ 7.3 GB is
  structurally impossible on web today.
- **The interactive wall comes far earlier than the memory wall:** a single-field
  edit re-reads the whole document, so every save is ~0.75 s at 100k and ~2 s at
  250k. The app is unusable well before it runs out of memory.
- Both walls are consequences of "the workspace is one CRDT unit." The record
  layer (§3) makes a 1-field edit O(1) and memory bounded by the visible page, not
  the dataset.

**Measured — record layer (`core/record`, same workload, on-disk SQLite):**

| tasks | heap | dbsize | edit | query | search |
|---:|---:|---:|---:|---:|---:|
| 10k | 1.9 MB | 15 MB | 0.7 ms | 0.3 ms | 0.2 ms |
| 100k | 1.9 MB | 150 MB | 0.7 ms | 0.3 ms | 0.2 ms |
| 500k | 1.9 MB | 761 MB | 0.8 ms | 0.3 ms | 0.2 ms |
| **1M** | **2.0 MB** | **1.5 GB** | **0.8 ms** | **0.4 ms** | **0.3 ms** |

**Every interactive metric is flat from 10k to 1M.** Head-to-head at the counts
that matter:

| | ygo whole-doc | record layer |
|---|---|---|
| heap @ 100k | 734 MB | **1.9 MB** |
| heap @ 1M | ~7.3 GB (web OOM) | **2.0 MB** |
| 1-field edit @ 100k | 746 ms | **0.7 ms** |
| 1-field edit @ 1M | (unreachable) | **0.8 ms** |
| full-text search @ 1M | (unreachable) | **0.3 ms** (FTS5, rare term) |

Heap is bounded because rows live on disk and only the visible page is read; edits
are O(1) because a write touches one entity's rows, not the document; search is a
sub-millisecond FTS5 index lookup. `dbsize` grows linearly (~1.5 KB/task); `seed`
(~98 s for a 1M one-shot bulk import) is a cold-start import cost, not an
interactive path — real use adds tasks incrementally.

This validates the two-layer design: **1M tasks, fully interactive, offline, with
full-text search — on the platform (web) the current model can't get a third of the
way to.**

The load test also earned its keep by catching two real bugs before they shipped:
an **O(N²) ordering blow-up** (a midpoint-toward-infinity append grew rank strings
unboundedly — now a fixed-width base-62 counter) and an **O(n) FTS rewrite on every
edit** (now skipped unless the searchable text changed).

Reproduce: `cd desktop && go run ./cmd/loadtest -engine both -n 10000,100000,500000`.

---

## 8. Implementation roadmap (phased)

Each phase is independently shippable and leaves the app working.

- **Phase 0 — Load-test harness (§7).** Synthetic data generator + measurement.
  Establishes the ceiling and the baseline. *No product change.*
- **Phase 1 — Query-oriented record layer (Go core).** ✅ `core/record`:
  `QueryTasks / SearchTasks / GetTask / MoveTask / SetTaskField / ToggleComplete /
  CreateTask / DeleteTask` + operator filters (§3) + title FTS + op-log sync.
  Unit-tested; validated at 1M (§7). *No UI change yet.*
- **Phase 2 — Frontend on the `RecordStore` port (§5.1).** *In progress — first
  real screen wired.* The web adapter (`public/record.worker.js`) + client
  (`src/store/recordClient.js`) are built, and the **live app's Today list now reads
  from the record store's query API** (`src/store/recordMirror.js` → `useRecordList`
  in `src/screens/ListScreen.js`). `TasksProvider` keeps the record store mirrored
  from current tasks; the Today branch renders from `queryList('today')` and falls
  back to the in-memory selector if the store isn't ready. Verified in the running
  app: a task created via the real composer is mirrored into `sqlite.wasm`/OPFS and
  returned by `queryList('today')`, which drives the rendered list. **Remaining:**
  per-entity writes to drop the mirror's transitional lag; port the other smart
  lists' filters into `queryList`. See the seam below.

  **Native adapters:**
  - *Desktop (Wails):* the WKWebView reports `Platform.OS==='web'`, so it uses the
    web `record.worker.js` adapter as-is — covered by the web work (build to confirm).
  - *Mobile (iOS/Android):* `core/record` is brought to parity with the web adapter
    (status/parentId/ord/`queryList`) and wrapped for gomobile (`mobile/record.go`,
    a JSON-string API mirroring the web adapter). `gomobile bind -target=ios` builds
    a **`RecordMobile.xcframework`** (device + simulator) exposing all `Record*`
    methods to native code — the Go record engine (incl. `modernc` SQLite) compiles
    and binds for iOS. **Remaining:** an RN native module bridging those methods to
    JS, a `RecordStore` adapter for `Platform.OS==='ios'`, and an app rebuild. The
    iOS app itself already builds + runs in the simulator (on its existing engine).
- **Phase 3 — Web adapter (§5.3).** JS record adapter over the official
  `sqlite.wasm` + OPFS VFS in a dedicated Worker, behind the `RecordStore` port;
  single-owner Web Lock across tabs. Prove 1M in-browser (heap bounded, query/FTS
  latency) first. Shares SQL/schema/wire-format with the Go engine; own no VFS.
- **Phase 4 — Text layer rescope.** ✅ Notes moved out of the workspace doc into
  **per-task ygo documents** (`core/ydoc` `note:<taskId>` scopes), loaded/synced on
  open (`backend.openTaskNote` → Go `Store.SyncNote`; `TaskDetailModal` drives
  open/close). Presence/cursors are already per-task. All four tiers.
- **Phase 5 — Scoped sync.** ✅ Every sync primitive is per-scope; the server routes
  `shared → t:<tenant>`, `note:<id> → t:<tenant>:note:<id>` (per-task room, on open),
  and `settings → u:<userId>` (`server/ysync` `roomKey`). Web loops scopes in
  `backend.wasmServerSync`; native in `ydstore.Sync`/`SyncNote`. *(Pushing record
  deltas over the WS — vs the nudge-then-pull that ships today — stays with Phase 7.)*
- **Phase 6 — User scope for settings.** ✅ Settings are their own per-user scope,
  keyed by the token's `UserID`, so they sync across a user's own devices and never
  enter the tenant broadcast — verified end-to-end (`TestSettingsAreUserPrivate`).
  Personal ordering can ride the same user scope next.
- **Phase 7 — Postgres server tier (§5.4).** Move the sync server off per-tenant ygo
  files onto the Go record engine backed by Postgres: `ops` log + `note_docs` +
  account tables; scope-routed push/pull; optional materialized projection + server
  FTS for server-only queries. Migrate the `auth` store to Postgres.

Migration between phases keeps the existing snapshot API working until a view is
cut over, so there is never a big-bang switch.

### Phase 2 integration seam (Today view)

The web adapter is proven; wiring a real screen is next. The lowest-risk first cut
is the **Today** list:

- **Read seam:** `src/screens/ListScreen.js` builds `tasks` for the Today list at
  `useSections` (≈ line 145) via `selectForList(state.tasks, 'today')` →
  `selectToday` in `src/store/selectors.js`. Replace that one branch with a page
  from `recordStore.queryTasks({...})`, delivered through an async hook
  (`useRecordQuery`). Keep the other lists on the in-memory selectors until each is
  cut over.
- **Write seam:** the `TaskRow` checkbox calls `toggleTask(id)` and reorder calls
  `reorderTasks(ids)` (`TasksContext.js`). For the Today view, route these to
  `recordStore.toggleComplete(id, …)` and `recordStore.moveTask(id, before, after)`.
- **Shape mapping (record ↔ app):** the app models completion as `status`
  (`open`/`completed`/`canceled`/`trashed`) and order as a numeric `order`; the
  record layer uses a `completed` boolean and a string `rank`. Map at the seam:
  `status==='completed' ⇄ completed`, `canceled`/`trashed` ⇄ a presence tombstone or
  a `status` field, and `order ⇄ rank`. The record schema should gain a `status`
  column when the cut-over needs the non-binary states.
- **"Today" filter** (`when ∈ {today,evening}` OR a concrete date ≤ today OR a
  deadline ≤ today, open, top-level) is a relative-date predicate: compute today's
  date on the client and pass it as `Query.Conditions` (`when` equality/`<=` +
  `completed=0` + `parentId IS NULL`), rather than the in-memory `isDueToday`.
- **Hydration:** on first run, `recordStore.hydrate(state.tasks)` imports current
  state into the OPFS DB (set-based, ANALYZE'd) so the query view has data.
