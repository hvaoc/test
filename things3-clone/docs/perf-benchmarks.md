# Performance benchmarks & observations

All measurements behind the 1M-task re-architecture ([architecture-1m.md](architecture-1m.md)),
in one place. Every number here is reproducible with the commands at the bottom.

Target: **a single workspace with 1,000,000 tasks, fully usable offline** —
create / edit / search / filter / reorder — on the constrained platform (web).

---

## 1. The wall — current model (ygo whole-document)

`core/ydoc` loads the entire workspace as one Yjs document in memory. Native Go
(`cmd/loadtest -engine ydoc`), notes ≈ 40 chars/task:

| tasks | heap | snapshot | load | materialize | 1-field edit |
|---:|---:|---:|---:|---:|---:|
| 10k | 74 MB | 3.6 MB | 103 ms | 59 ms | 74 ms |
| 100k | 734 MB | 38 MB | 1.17 s | 707 ms | **746 ms** |
| 250k | 1.8 GB | 96 MB | 2.85 s | 1.96 s | **1.99 s** |
| 500k | 3.6 GB | 194 MB | 5.9 s | 4.5 s | **4.1 s** |

- Dead-linear at **~7.3 KB resident heap per task**.
- **Web (wasm32, ≤4 GB address space) OOMs at ~400–500k.** 1M ≈ 7.3 GB is
  structurally impossible on web.
- The **interactive** wall comes even earlier: a single-field edit re-reads the
  whole document, so every save is ~0.75 s at 100k, ~2 s at 250k.

Both walls are consequences of "the workspace is one CRDT unit."

---

## 2. The fix — record layer (query-oriented SQLite)

`core/record` keeps the same field-level CRDT (LWW + HLC + op-log) but exposes a
query API: rows in SQLite, per-entity writes, paged/indexed reads, title FTS5.
Native Go (`cmd/loadtest -engine record`), on-disk SQLite:

| tasks | heap | dbsize | edit | query | search |
|---:|---:|---:|---:|---:|---:|
| 10k | 1.9 MB | 15 MB | 0.7 ms | 0.3 ms | 0.2 ms |
| 100k | 1.9 MB | 150 MB | 0.7 ms | 0.3 ms | 0.2 ms |
| 500k | 1.9 MB | 761 MB | 0.8 ms | 0.3 ms | 0.2 ms |
| **1M** | **2.0 MB** | **1.5 GB** | **0.8 ms** | **0.4 ms** | **0.3 ms** |

**Every interactive metric is flat from 10k to 1M.** Heap is bounded (rows on disk,
only the visible page read); edits are O(1) (one entity, not the document); search
is a sub-ms FTS5 lookup. `dbsize` grows linearly (~1.5 KB/task). `seed` (~98 s for a
1M one-shot import) is a cold-start cost, not an interactive path.

### Head-to-head (the counts that matter)

| | ygo whole-doc | record layer |
|---|---|---|
| heap @ 100k | 734 MB | **1.9 MB** |
| heap @ 1M | ~7.3 GB (web OOM) | **2.0 MB** |
| 1-field edit @ 100k | 746 ms | **0.7 ms** |
| 1-field edit @ 1M | (unreachable) | **0.8 ms** |
| full-text search @ 1M | (unreachable) | **0.3 ms** |

---

## 3. Web proof — sqlite.wasm + OPFS in the browser

The record layer's design measured on the actual web engine
(`public/sqlite-bench.html`): official `sqlite.wasm` + OPFS VFS, in a dedicated
Worker, **page cache pinned at 2 MB** so the engine cannot hold the DB in memory —
it pages from the OPFS file on disk.

| tasks | edit | query | FTS search |
|---:|---:|---:|---:|
| 100k | 13.6 ms | 11.8 ms | 5.7 ms |
| **1M** | **19.0 ms** | **23.2 ms** | **14.5 ms** |

Latency barely moves from 100k → 1M though the database is **300×+ larger than the
2 MB cache** — memory is bounded by the working set, exactly as on native. Numbers
are higher than native Go (sub-ms) because each cache miss is an OPFS read, but they
are an order of magnitude inside "instant" and run off the UI thread. **1M offline
on the web is confirmed usable.**

---

## 4. Bugs the load test caught (before they shipped)

- **O(N²) ordering blow-up.** The append rank used a midpoint-toward-infinity, which
  converges on the top digit and then grows the rank string ~1 char every few
  appends → 1M sequential appends produced multi-thousand-char ranks. The database
  ballooned to **4.6 GB at 100k**, and seed/edit/search all went superlinear. Fixed
  with a **fixed-width base-62 append counter** (`Pad62`); `RankBetween` (midpoint)
  is kept only for inserts between real neighbours.
- **O(n) FTS rewrite per edit.** `reproject` rewrote the FTS row on every edit, and
  `DELETE … WHERE id` scans an FTS table (id is UNINDEXED) → edit cost grew with N
  (33 ms at 100k). Fixed by rewriting FTS **only when the title changes**; other
  edits (complete/priority/date/reorder) stay O(log n).

The harness paid for itself: both were invisible in unit tests and only appeared
under scale.

---

## 5. Web / OPFS operational learnings

These harden the code on every tier (several apply to the native Go store too):

1. **Single-owner is mandatory, and crash recovery is slow.** A Worker killed
   mid-transaction held its OPFS SAHPool handles **>60 s** before the browser
   released them. So: elect one owner via a Web Lock and hand off gracefully; never
   spawn a competing worker; recover from an abrupt crash by acquiring a **fresh
   pool** rather than busy-waiting on wedged handles.
2. **Indexes must cover the actual view queries + `ANALYZE`.** Without a composite
   `(projectId, completed, rank)` index and stats, SQLite full-scanned and a list
   query took **235 ms**; with them, **7 ms**. Same index design applies to the
   native Go store.
3. **Bulk import must be set-based.** A per-row JS→WASM insert loop capped at
   ~1k rows/s; generating rows inside SQLite (recursive CTE / `INSERT … SELECT`)
   seeded 1M in seconds. The initial-sync/hydrate path on all tiers should import in
   bulk, not row-by-row.
4. **Bounded memory is a `cache_size` guarantee, not luck** — pin the steady-state
   page cache small; use a large cache only transiently during import.
5. **Monotonic (zero-padded) ids** give sequential primary-key locality, avoiding
   random-write thrash during large imports.

---

## 6. Reproduce

```bash
# Native — the wall and the fix, side by side (Go):
cd desktop && go run ./cmd/loadtest -engine both -n 10000,100000,500000
#   add 1000000 to the list for the full curve (record layer only reaches it).

# Native — record layer only, to 1M:
cd desktop && go run ./cmd/loadtest -engine record -n 100000,500000,1000000

# Web — sqlite.wasm + OPFS, in the browser:
#   start the web dev server, then open /sqlite-bench.html and read the table.
```

Harnesses: `desktop/cmd/loadtest/main.go` (native), `public/sqlite-bench.html` +
`public/sqlite-bench.worker.js` (web).
