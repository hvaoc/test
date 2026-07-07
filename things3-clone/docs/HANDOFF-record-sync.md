# Handoff — record-engine sync migration

Branch: **`claude/things3-todo-app-clone-e0zgnc`**. Everything below is committed.

## What this session did (the arc)

Retired the **single whole-workspace ygo doc** as the sync unit for structured data and
replaced it with the **record engine's field-level op-log** (LWW registers + HLC), which
scales to 1M via O(change) deltas. Then made the web app fully offline-first + multi-tab,
and moved server persistence onto Postgres with a **materialized register store**.

### Done + verified
- **Three sync scopes** (`453cdca`): shared (tenant) / `note:<taskId>` (per-task, on-demand) /
  settings (per-user, `u:<userId>`). Fixed the settings-leak correctness bug. All in the shared
  Go core (`core/ydoc`), so web/desktop/mobile inherit it. Go tests green.
- **Record op-log foundation** (`6e83a39`): `core/record/snapshot.go` = whole-state seam for ALL
  entity kinds (areas/projects/headings/tasks/customViews/tags), delta-only op emission.
  Server per-tenant op-log endpoints `/v1/records/{push,pull}` (`server/ysync/records.go`).
- **Web wired onto record engine** (`03d5251`, `f91905f`): `backend.js` coordinator — structured
  data via record op-log, notes+settings via ygo. **ygo shared doc retired on web.**
  `record.worker.js` got the JS port of the whole-state seam + op-log sync. Verified live
  (migration, read, write persist across reload).
- **Multi-tab, offline** (`b1bb5e1`): OPFS SQLite is single-owner, so `recordClient.js` does
  **leader election** (Web Locks) + **BroadcastChannel** proxy. One tab owns the DB; others proxy;
  writes broadcast `changed`; tabs reload live. Verified via iframe (a real 2nd instance synced).
  (SharedWorker was tried and reverted — OPFS SAHPool needs a dedicated worker.)
- **Offline app shell** (`bdefcab`): `public/service-worker.js` (network-first + cache fallback),
  registered in `App.js`. Verified on the **production build** (`dist-web`) with the server killed —
  app rendered from cache. Dev server (Metro) can't be offline-tested (lazy chunks + HMR).
- **Instant structural writes** (`a4c7079`, `0ec23a3`): save-debounce 250→100ms; structural
  actions (move/complete/reorder/reschedule) flush at 0ms via a `flushSaveRef` in `TasksContext.js`.
  Same-tab ~69ms, cross-tab ~120ms, no revert.
- **Today re-query fix** (`4db692e`): `onRecordWrite`/`onRecordChanged` → `recordMirror` bump, so
  `useRecordList` re-runs on this-tab writes + cross-tab changes.
- **Postgres persistence** (`6d77f53`): `PostgresPersistence` (blob KV `sync_blobs`) + `-postgres <dsn>`
  flag on `cmd/ysync-server`. Real-PG test via embedded-postgres.
- **Materialized Postgres record engine** (`9972ba3`): `pgRecordStore` (`server/ysync/pgrecord.go`) —
  applies ops into a **LWW-register table `record_registers`** (one row per entity/field). Bounded,
  server-queryable, first-login = full copy. `RecordStore` interface (blob vs pg). One-time
  `MigrateBlobLog`. Tested on real PG. Live: bella's data = 34 task registers, queryable.
- **Docs**: `docs/tombstone-gc.html` (sequence diagrams + GC code) (`9718aae`, `2fc55eb`),
  `docs/architecture-1m.md` §8 updated, `docs/build-sizes.md`.

### NOT done / pending
- **Task #3 — native coordinator (Wails desktop + gomobile iOS/Android).** Native still saves
  structured data via **ygo (`core/ydstore`)**, so **web ↔ native don't converge on tasks yet.**
  Needs a Go coordinator (record for structured + ygo for notes/settings) and must **unify the
  single `record.Store`** between the save path and the query path (`desktop/mobile/record.go`).
  Fully Go-testable; device rebuilds are slow (~30–70min on this machine).
- **Tombstone GC — design only** (see `docs/tombstone-gc.html`). `record_registers` keeps tombstones
  (`present=false`) forever → slow leak. Plan: add `deleted_at` column + hourly purge
  (`WHERE present=false AND deleted_at < now()-'35 days'`) + orphan sweep on the server;
  `last_sync_at` gap check on the client (incremental vs push→wipe→full-reload). Not wired.
- **Per-op ops table** (vs the register store): registers lose edit history (fine — nobody queries
  the DB directly, confirmed by user). Register store already bounds growth for LIVE data.
- Frontend query cutover beyond the **Today** view (other lists still use in-memory selectors) —
  works via the whole-state seam; per-entity O(1) writes are the 1M-scale follow-up.

## Running infrastructure (temporary — may not survive a restart)
- **Metro dev server** `:8088` — the web app (dev). bella@test.dev signed in, points at `:8090`.
- **ysync-server** `:8090` — `/tmp/ysync-server-pg` running with
  `-postgres "postgres://things:things@localhost:5432/things?sslmode=disable" -data /tmp/ysync-reset`.
  Rebuild from source: `go run ./cmd/ysync-server -addr :8090 -postgres "<dsn>" -data /tmp/ysync-reset -app-url http://localhost:8088`
- **Docker Postgres** `things-postgres` (postgres:16) `:5432`, host volume **`/Users/madd/data/postgres`**.
  DSN above. Inspect: `docker exec things-postgres psql -U things -d things -c "SELECT scope,count(*) FROM ..."`.
- **dist-web static** `:8099` (production build, offline demo) and **docs static** `:8077`
  (`docs/tombstone-gc.html`) — throwaway `python3 -m http.server`; kill with `pkill -f http.server`.

## Gotchas
- **Bash `grep` is flaky on `public/record.worker.js`** in this sandbox (returns no matches for
  strings that exist). Use Read/Edit/node, not shell grep, on that file.
- Switching the server's record store (blob↔pg) doesn't migrate the client cursor (blob=offset,
  pg=seq); harmless (LWW idempotent), local data stays intact.
- Repo-root `CLAUDE.md` describes an unrelated "PlayMap" project — the REAL app is `things3-clone/`.

## Suggested next step
Native coordinator (Task #3) to make web↔desktop↔mobile converge on structured data, **or** wire
the tombstone-GC design from `docs/tombstone-gc.html`. Both are contained; native needs the
one-`record.Store` unification, GC needs the `deleted_at` column + purge job + client gap check.
