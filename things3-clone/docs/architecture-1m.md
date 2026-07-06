# Architecture: local-first at 1,000,000 tasks

Status: **accepted, implementation in progress**
Scope: the offline data + sync core shared by web (WASM), desktop (Wails), and
mobile (gomobile).

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
storage, search, and filter work with bounded memory. Full-text search is SQLite
**FTS5**.

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

> **This also fixes a current correctness bug.** Settings today live in the shared
> `settingsRoot` map of the tenant ygo document (`core/ydoc/ydoc.go`), so changing a
> setting *propagates to teammates* — the opposite of the requirement. The user
> scope corrects this, not just scales it.

---

## 3. The record layer at 1M — the query-oriented API

The existing CRDT semantics (LWW registers, add-wins sets, presence tombstones,
HLC, oplog) are **kept as-is** — they're correct and already cross-platform
byte-compatible. What changes is the **shape of the API**, because
`SaveSnapshot`/`LoadSnapshot` (whole-workspace) is the thing that doesn't scale.

**Reads become queries, not materializations.** New store methods return only what
a screen shows, backed by indexes:

- `QueryTasks(scope, filter, sort, page)` — e.g. tasks in project P, or matching a
  saved filter, ordered by `rank`, limited/paged. Backed by SQLite indexes on
  `projectId`, `when/due`, `priority`, `state`, and the fractional `rank`.
- `SearchTasks(text, filter, page)` — FTS5 `MATCH` over title/notes-preview +
  structured predicates. Offline, bounded memory.
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

## 5. Per-platform storage — one logical model

| Platform | Record layer store | Text layer | Notes |
|---|---|---|---|
| Desktop (Wails) | native SQLite via Go core (`modernc.org/sqlite`) + FTS5 | ygo per-task | no memory concern at 1M |
| Mobile (gomobile) | native SQLite via the same Go core + FTS5 | ygo per-task | same code as desktop |
| Web (WASM) | SQLite-WASM (OPFS, single-tab-owner Web Lock) **or** IndexedDB indexed store | ygo per-task | web is the constrained platform; the read-model is disposable/rebuildable so single-context is acceptable |

The record-layer engine + sync live in the **shared Go core** so all three
platforms run one logical model (the project's "Do Not Repeat" rule). ygo stays for
the text layer. We stay in Go; never y.js.

> Note on web storage: the recent move of the *whole-doc* blob to IndexedDB fixed
> the OPFS access-handle crash. At 1M the record layer needs indexed queries/FTS,
> which argues for SQLite-WASM again — but now as a *disposable, single-owner read-
> model*, not the source-of-truth blob, so the access-handle constraint is tolerable
> (Web Lock elects one tab; corruption is recoverable by rebuild). Final web-storage
> choice is Phase 3, gated on the load-test numbers (§7).

---

## 6. The trade we are choosing deliberately

The two-layer split trades **whole-workspace character-level collaboration** for
**database scale + offline SQL search**. Cross-task realtime becomes "field deltas
stream in" (rows update live) rather than "one shared document"; character-level
co-editing with cursors remains, scoped to whichever task's notes people are inside.
For a task app that is the right trade. We are choosing it with eyes open.

---

## 7. Prove-the-wall (validation gate)

Before/while building, a load test generates 100k / 500k / 1M synthetic tasks and
measures, on web-WASM and native: heap, startup decode/materialize time, and
per-keystroke search latency for (a) today's whole-doc model and (b) the query-
oriented record layer. This pins the current ceiling and proves the new engine
against real numbers. It commits us to nothing and is the cheapest thing here.

---

## 8. Implementation roadmap (phased)

Each phase is independently shippable and leaves the app working.

- **Phase 0 — Load-test harness (§7).** Synthetic data generator + measurement.
  Establishes the ceiling and the baseline. *No product change.*
- **Phase 1 — Query-oriented record layer (Go core).** Add `QueryTasks /
  SearchTasks / GetTask / Move / SetField / ToggleComplete / Create / Delete` +
  the FTS5/index read-model to `core.Store`, alongside the existing snapshot API.
  Unit-tested against the CRDT semantics. *No UI change yet.*
- **Phase 2 — Frontend on queries.** Views/lists read via paged queries + live
  deltas instead of the materialized whole-state; writes go per-entity. Ordering
  via `rank` writes. Decide shared-vs-personal sidebar order.
- **Phase 3 — Web storage for the record layer.** SQLite-WASM (single-owner Web
  Lock) or IndexedDB indexed store, per the load-test. Record layer runs in the
  worker on all platforms.
- **Phase 4 — Text layer rescope.** Move notes from the workspace doc into per-task
  ygo documents, loaded on open; wire cursors/awareness per task.
- **Phase 5 — Scoped sync + push-over-WS.** Server routes tenant vs user scope;
  record deltas pushed on the WebSocket; per-task doc rooms on open.
- **Phase 6 — User scope for settings + personal ordering.** Per-user prefs stream
  routed only to the user's own sessions; migrate settings off the tenant stream.

Migration between phases keeps the existing snapshot API working until a view is
cut over, so there is never a big-bang switch.
