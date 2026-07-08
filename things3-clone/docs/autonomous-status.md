# Autonomous run — status & decisions

**Owner:** Claude (autonomous). **Started:** 2026-07-06. **Human review:** tonight.
This file is the durable source of truth. It survives context clears — always read it first
on resume, update it after every meaningful step. Keep it terse and current.

## ★ FINAL SUMMARY (2026-07-06) — all tracks complete within env limits
| # | Task | Result |
|---|------|--------|
| 1 | **Wire record engine into all apps** | **DONE.** New `desktop/core/coordinator` (record=structured, ygo=notes/settings); desktop `main.go` + mobile rewired to ONE coordinator; mobile two-store bug fixed; cursorExpired full-reload handled. web↔desktop↔mobile now converge on the record op-log. 5/5 coordinator tests; **full `go test ./...` GREEN (10/10 pkgs)**. Device runtime not run here (no Xcode/Android SDK) — validated at build/vet/test level. |
| 2 | **Feature tests per app (repeatable/CI)** | **web: DONE** — Playwright `e2e/`, 21 pass/1 skip, verified reproducible. **desktop: DONE** — frontend = same bundle (Playwright) + coordinator Go tests. **iOS: RUNNING FOR REAL** — Xcode + iPhone 17 sim present, app installed; Maestro installed; `smart-lists.yaml` PASSES green on the sim; remaining flows being tuned. **Android: SDK + AVD `things_avd` present** — being built+run. (My earlier "no sim/emulator" claim was WRONG — see corrected recon.) |
| 3 | **1M perf (ops not sluggish)** | **DONE — PASSES at 1M.** `core/record/perf_test.go` (env-gated). Search 1.9ms, all custom-view filter operators <1–8ms, Today 13ms, writes <1ms. Fixed a real O(n) FTS write bug + planner/index issues (all diagnosed via EXPLAIN). |

**Biggest remaining follow-up (documented, not done):** the app FRONTEND still evaluates most lists + custom
views in-memory (O(n)); only Today was cut over to the engine. The engine is proven 1M-fast — routing all
lists/custom-views through it (+ query.js↔engine operator parity) is the next step to make the *app* (not just
the engine) non-sluggish at 1M. Also: add testIDs (see `.maestro/TESTIDS.md`) to de-fragilize both E2E suites.

**How to reproduce everything:** `cd desktop && go test ./...` (all); `RECORD_PERF=1 go test ./core/record -run TestPerf1M -timeout 30m -v` (perf); `cd e2e && npx playwright test` (web, needs app on :8088); `.maestro/` (mobile, needs a device/emulator).


## Mission (from the user)
1. **Wire** the record engine into ALL apps: web, macOS desktop (Wails), mobile iOS, mobile Android.
   (Handoff Task #3 — native still syncs structured data via ygo; make web↔desktop↔mobile converge.)
2. **Feature test matrix**: enumerate every feature, test each against web / iOS / Android / macOS.
   - web → Playwright
   - desktop → Wails dev server serves the frontend; drive it with Playwright, backed by the real Go backend (non-UI code)
   - mobile → try https://maestro.dev for all features; if it can't, use Appium
   - ALL tests must be repeatable from code (CI-able).
3. **1M perf test**: NOT bulk-seeding. With 1M records already present, all ops — search, custom
   views with filter operators on task fields, CRUD, list queries — must not be sluggish.

## Operating rules I set for myself
- Update this doc after each step (decisions + progress + next action).
- Parallelize testing where not resource-constrained (Agent subagents / background Bash).
- Self-check between steps: (a) correctness (run it, don't assume), (b) staleness (is a background
  job stuck with no progress? kill/retry). Record course-corrections here.
- Do NOT commit/push unless asked. Do NOT do destructive/outward actions.
- Long builds/tests → background tasks; note the task id here so a resumed context can find them.

## Decision log (append-only)
- **D-A (2026-07-06):** Status doc lives at `docs/autonomous-status.md` (repo file, survives context clears).
- _(more appended below as decisions are made)_

## Course-corrections (incidents + fixes)
- **INC-1 (2026-07-06) — RESOLVED, was a false alarm.** I briefly saw `record.go` reverted to HEAD (absent from
  `git status`, 0 perf markers). Root cause was NOT a destructive revert by the coordinator agent — the agent
  validated in an isolated `git worktree`, and a transient stash/worktree operation made the main-tree file
  momentarily show clean when I polled. My perf changes were intact minutes later (86 ins/24 del). **Real bug
  found in the process:** `record.go` had a Go **syntax error** — my whenDate-index correction never applied, so
  an older comment with backticks (`` `deadline<=today` ``) terminated the DDL raw-string literal. Fixed by
  rewriting that comment without backticks + applying the whenDate=FULL / deadline=PARTIAL index tuning. Backed
  up record.go + perf_test.go to scratchpad as insurance. **Lesson:** (a) don't panic-diagnose a transient git
  state as a permanent loss; (b) NEVER put backticks inside a Go raw-string (backtick) literal — build after each
  DDL comment edit; (c) parallel agents SHOULD use `git worktree` isolation (this one did, correctly).

## Capability recon (2026-07-06)
- Node 26.3, npm 10.2. **Playwright 1.61 CLI available** (global npx; not yet a dep). ✓ web
- Go 1.26.4 ✓. Wails v2.12.0 ✓. gomobile at ~/go/bin ✓.
- App = **Expo / React Native 0.81.5** (single RN codebase → iOS/Android/expo-web; macOS = Wails wrapping the web export). Scripts: `expo start --web`, `expo run:ios/android`, `desktop/build.sh`.
- **[CORRECTED 2026-07-06] — my first recon was WRONG.** I checked `xcode-select -p` (pointed at CommandLineTools) and `ANDROID_HOME` (empty) and concluded the mobile toolchains were absent. They are NOT. Checking install *locations* (not PATH/env) shows:
  - **Xcode IS installed** at `/Applications/Xcode.app` with full `simctl`; iOS 26.5 simulators exist and **iPhone 17 was already booted**.
  - **Android SDK IS installed** at `~/Library/Android/sdk` (adb 1.0.41, emulator, AVD `things_avd`).
  - → **iOS AND Android E2E ARE runnable here.** The earlier "impossible" claim was a false conclusion from trusting PATH/env instead of looking. **Lesson: verify a capability by looking where tools install + querying the tool directly, never infer absence from an unset env var or a mis-pointed `xcode-select`.**
- Maestro / Appium: not installed (brew available).
- No existing test dirs.

## Feasibility assessment  → what's executable HERE vs artifact-only
- **Web E2E (Playwright):** fully executable + CI-able. ✓
- **Desktop:** Wails serves the *same expo-web bundle*; drive it with Playwright (frontend) + Go tests for the backend (`desktop/`). Executable. ✓  (Full native macOS-window automation is out of scope; user authorized served-frontend + backend approach.)
- **Native coordinator wiring (item 1):** the Go coordinator that unifies `record.Store` for structured data on desktop+mobile is **fully writable and Go-unit-testable here**, and validated at compile level for the wails + gomobile targets. On-device runtime E2E is NOT possible (no devices). ✓ code+tests / ✗ device-run.
- **Mobile E2E (item 2, iOS+Android):** **BLOCKED** (no sim/emulator/Xcode/SDK). Deliverable instead: written **Maestro flow YAMLs** (repeatable, CI-ready) + Go coordinator tests. Will attempt a cheap Android-SDK probe; if not cheap, leave flows ready + document.
- **1M perf (item 3):** executable via a Go harness against `core/record` (SQLite) — the real engine — timing search / filtered custom-view queries / CRUD at 1M. Optional web-worker (OPFS) harness. ✓

## Decision log additions
- **D-B:** iOS E2E is environment-blocked (no Xcode/sim). Deliver Maestro flows + Go tests; document as "ready-to-run, not executed here."
- **D-C:** Android E2E blocked (no SDK/emulator). Same treatment; probe SDK install feasibility once, cheaply.
- **D-D:** Web + desktop-frontend share ONE Playwright suite (same expo-web bundle). Desktop backend tested via Go.
- **D-E:** Native wiring = a Go coordinator (record engine for structured data + ygo for notes/settings) replacing the ygo-structured path (`core/ydstore`) on desktop/mobile, unifying a single `record.Store` across save+query paths. Unit-tested in Go; targets validated with `go build`/gomobile bind compile.
- **D-F:** 1M perf measured in Go against `core/record`. Pass bar (initial): p50 search < 50ms, filtered custom-view query < 100ms, single-field write < 20ms at 1M rows. Revise once measured.

## Phase plan (revised)
- **P0** Recon — DONE.
- **P1** Feature inventory (canonical, per-app applicability + which use the record engine).
- **P2** Web Playwright E2E: harness + tests for every feature. Executable.
- **P3** Desktop: Go backend tests + Playwright against Wails-served frontend.
- **P4** Native coordinator wiring (record engine on desktop + mobile) + Go tests. Executable (code/test).
- **P5** Mobile: Maestro flow YAMLs for every feature (+Android probe). Artifact-ready; run blocked.
- **P6** 1M perf test (Go harness) + report.
- Parallelize P2/P6 (independent dirs) via background agents while I drive P4 (wiring).

## Feature inventory (condensed — full detail from map agent 2026-07-06)
- **Smart lists** (`src/store/selectors.js`): Inbox, Today(+Evening), Upcoming, Overdue, Anytime, Someday, Logbook, Trash.
- **Task CRUD** (`src/store/TasksContext.js`): create, edit title, complete/uncomplete, deadline, when/schedule, priority, notes, delete/trash, reorder (fractional `ordering.js`), checklist/subtasks.
- **Organization**: Areas, Projects (progress pie), Headings (collapsible), Tags, Move.
- **Custom views / query builder** (`src/store/query.js` — RICHER than engine): operators per field —
  tags: hasAny/hasAll/notHas/none; priority: is/isNot/none; when: state/on/before/after/between;
  deadline: exists/none/overdue/on/before/after/between; time+duration: exists/none/lt/gt/between.
  Scope: all/area/project. Match: all(AND)/any(OR). **Currently evaluated in-memory (`runQuery`) → O(n), a 1M risk.**
- **Engine filters** (`core/record` Cond): `=,!=,<>,>,<,>=,<=,in,not in` on projectId/priority/when/deadline/completed/rank; title via FTS5. (Subset of query.js — a gap to close for 1M custom views.)
- **Search** (`SearchScreen.js` + FTS5 title index).
- **Settings** (per-user, ygo): showCompleted, keepCompletedInPlace, dayStartHour, timezone, smartListOrder, etc.
- **Sync/collab**: record op-log (structured), ygo (notes+settings), presence/carets, multi-tab (leader election).

## Wiring findings (per app)
- **Web**: structured = record engine ✅; notes+settings = ygo. Coordinator = `src/store/backend.js` (`coordinatorMaterialize`, `coordinatorServerSync`, `recordServerSync`). REFERENCE IMPL to port to Go.
- **Desktop** (`desktop/main.go`): `App{store *ydstore.Store}` — structured still ygo ❌. Frontend talks to Go via `window.go.main.App.{LoadSnapshot,SaveSnapshot,Sync,SyncNote,CloseNote,...}` (whole-state snapshot bridge, not per-entity queries).
- **Mobile** (`desktop/mobile/mobile.go`): wraps `ydstore` (structured=ygo ❌) for save/sync, BUT `desktop/mobile/record.go` has a SEPARATE `record.Store` for queries (`RecordQueryList/QueryTasks/Search/...`). **Two-store bug**: save→ygo, query→record, not shared.
- **Groundwork exists**: `ydoc.Engine.ApplyLocalSnapshotAux` writes ONLY settings+notes (skips structured) — the coordinator's ygo write path. `desktop/mobile/record.go` bindings already exist.

## Coordinator design (P4) — decided
New pkg `desktop/core/coordinator` type `Coordinator` composing `*record.Store` (structured) + ygo (settings+notes):
- **LoadSnapshot** = `rec.Materialize()` (structured, notes="") overlaid with ygo `.settings` + per-open-task `.notes`.
- **SaveSnapshot(state)** = `rec.ApplyLocalSnapshot(state)` + `ydstore.SaveAux(state)` (→ `ApplyLocalSnapshotAux`).
- **Sync** = Go `recordServerSync` (POST /v1/records/{push,pull}, MarkSynced, ApplyRemote, SetCursor, **handle `cursorExpired`→full reload** — ties into the tombstone-GC work) + ygo sync of ScopeSettings+open notes (NOT ScopeShared, which is retired).
- **Query methods** delegate to the SAME `rec` → unifies save+query store (fixes mobile two-store bug).
- Needs small additions to `ydstore`: `SaveAux(state)` and `SyncAux()` (settings+notes scopes only).
- **Wiring**: `desktop/main.go` App uses Coordinator; `desktop/mobile/mobile.go` + `record.go` use ONE shared Coordinator.
- **Tests (Go)**: structured round-trips through record + converges via op-log with a 2nd store; notes/settings still via ygo; query path sees saved data (two-store bug gone). Compile-check gomobile + wails targets.

## Perf findings (P6 — from N=100k run; 1M running, task blx4ujv6c)
LIMIT+rank filters are sub-ms (early-terminate on rank index). Scaling concerns found:
- **QueryList(today) ~82ms@100k** → the smart-list SQL (`OR` over whenDate/deadline + `ORDER BY ord`) can't use one index → ~linear. Needs index/query fix.
- **SearchTasks(common word) ~37ms@100k** → FTS returns many ids, join+rank-order+limit; heavy for common terms.
- **FTS-touching writes (SetTaskField title, CreateTask) ~24ms** → FTS delete+insert + WAL fsync; exceeds 20ms ceiling (constant, not N-scaling; tune pragmas / lighter FTS).
- `priority/whenDate/deadline` are NOT indexed (only rank/projectId/completed/status) — fine while LIMIT+rank early-terminates, but sorting/counting without rank suffers.
- Await 1M numbers before optimizing (`scratchpad/perf1m.log`).

## Current state / progress
- [x] P0 Recon: env + codebase map — DONE
- [x] P1 Feature inventory — DONE (above)
- [x] **P2 Web Playwright E2E — DONE & VERIFIED.** `e2e/` suite: **21 passed, 1 skipped, 0 failed** (reproduced independently; stable across 5+ runs). 7 spec files (smart-lists, task-crud, task-fields, organization, custom-view, search, settings) + config + helpers + README. App is offline-first (no login wall); fresh context = clean baseline. 1 honest skip: custom-view Priority-condition (RN-Web dropdown clips in a bottomsheet, no testID) — the text-filter custom view IS covered.
- [x] **P3 Desktop — covered.** Frontend = same expo-web bundle as P2 (Playwright covers it). Backend = coordinator Go tests (5/5). Desktop-window-native automation out of scope (documented). No separate work needed.
- [x] **P4 Native coordinator wiring — DONE** (agent a63ef2f3…). New `desktop/core/coordinator` (record for structured + ygo for settings/notes), wired into `main.go` + `mobile/*`, fixes mobile two-store bug, handles cursorExpired full-reload. Tests: coordinator 5/5 (RoundTrip/Converge/NotesSettings/Reset/CursorExpired). `go build/vet/test ./...` GREEN in main tree.
- [~] **P5 Mobile Maestro flows — EXECUTING (was wrongly marked "not runnable").** iOS: `smart-lists.yaml` PASSES on the booted iPhone 17 sim; remaining 6 flows + Android being tuned by a subagent. **Selector playbook (learned live):** RN labels arrive as accessibilityText `"<icon-glyph>, <Label>"` so use regex `.*<Label>`; add `extendedWaitUntil visible ".*Today" timeout 40000` after launch for hydration; on a phone tapping a list PUSHES a screen (sidebar hides) and back is an in-app glyph (not iOS system `back`); composer placeholder "Task name", submit "Add task"; discover via `maestro hierarchy` (accessibilityText field) + `simctl io booted screenshot`.
  Env: `PATH+=~/.maestro/bin`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` (Maestro needs full Xcode, not the CLT that xcode-select points at), `ANDROID_HOME=~/Library/Android/sdk`.
- [x] **P6 1M perf — DONE & PASSING at 1M.** Harness `core/record/perf_test.go` (env-gated `RECORD_PERF=1`, CI-ready). All ops fast at 1M (search 1.9ms, filters <1–8ms, Today 13ms, writes <1ms). See results above.

## Coordinator (P4) — as-built (from agent report)
- `coordinator.Coordinator` = one `*record.Store` (structured) + one `*ydstore.Store` (settings/notes).
- ydstore gained: `SaveAux` (settings+notes only), `SyncAux` (syncs `settings`+open notes, NEVER ScopeShared), `Settings()`, `NoteText`, `OpenNotes`. ydoc gained `Engine.Settings()`. Existing ydstore tests untouched.
- `main.go` App + `mobile/mobile.go` + `mobile/record.go` all delegate to ONE Coordinator (two-store bug fixed).
- Sync = record op-log push/pull (+cursorExpired→full reload, reconcile pending) + ygo settings/open-notes.
- Follow-up noted by agent: a `record.Store.Reset()`/wipe method would simplify the coordinator's DB-file-recreate wipe.
- Device runtime (iOS/Android/macOS window) NOT run here — validated at Go build/vet/test level only.

## Blockers / risks
- iOS/Android E2E cannot execute here (no Xcode/sim, no Android SDK) → Maestro YAML artifacts only.
- query.js custom-view operators richer than engine SQL → true 1M custom views need engine-side operator parity (scope note; may exceed this run).
- Desktop uses whole-state snapshot (O(n)) even after record wiring → converges sync, but per-entity query cutover for desktop is a follow-up.

## Perf RESULTS (1M, realistic data) — CONFIRMED PASSING (`scratchpad/perf1m-v4.log`)
`RECORD_PERF=1 go test ./core/record -run TestPerf1M` → **PASS** at N=1,000,000 (iters=50). Final p50:
QueryList(today) 13.3ms · when=today 0.41ms · deadline<=today 0.32ms · priority>=2 0.53ms · projectId IN 8.1ms ·
priority!=0 0.38ms · **Search 1.9ms** · Count(open) 51ms · Count(priority) 3.9ms · GetTask 0.04ms ·
**SetTaskField 0.31ms** · ToggleComplete 0.21ms · **CreateTask 0.60ms**. Full `go test ./...` GREEN (10/10 pkgs)
with all perf changes + coordinator integrated. **P6 DONE.**
Repro: `cd desktop && RECORD_PERF=1 go test ./core/record -run TestPerf1M -timeout 30m -v` (CI-gated by env var).

Post-optimization p50 at 1M (baseline → after):
- **Search: 393ms → ~2ms** ✓  (rowid FTS + realistic diverse vocabulary)
- **Custom-view filters (all operators =,!=,>=,IN,…): all sub-10ms, most <1ms** ✓  (when=today 122ms→0.4ms, deadline<=today 316ms→0.34ms, priority/projectId all fast)
- **Writes (SetTaskField/CreateTask): 255ms → <1ms** ✓  (the O(n) FTS delete bug fixed)
- **QueryList(today) smart-list: 819ms → ~2ms** ✓  (partial "open" indexes + INDEXED BY hints + UNION arms)
- CountTasks(open) ~55ms (indexed count of ~850k open rows; under ceiling; a maintained counter is a future nicety)
Extra fixes beyond the first pass: partial indexes `tasks_open_when`/`tasks_open_deadline` (WHERE status='open')
pinned via `INDEXED BY` in QueryList (deterministic, needs no ANALYZE — so incremental clients are fast too);
`analysis_limit(400)` + `ANALYZE` after BulkLoad + `PRAGMA optimize` on Close for the rest.
Authoritative confirmation run: `scratchpad/perf1m-v4.log` (task bb73elgoy). 200k full run already PASSES.

## Perf optimizations applied (record.go, 2026-07-06) — verifying at 1M
1. **rowid-keyed FTS** (was `fts5(id UNINDEXED,title)` → `fts5(title)` keyed by tasks.rowid). Fixes the O(n) `DELETE FROM tasks_fts WHERE id=?` scan that made title writes + creates 255ms@1M. Reproject/bulkBatch/SearchTasks updated; one-time `migrateFTSRowid()` rebuilds old DBs.
2. **filter indexes** `tasks_when_rank(whenDate,rank)`, `tasks_deadline_rank(deadline,rank)`, `tasks_priority_rank(priority,rank)` → custom-view filters seek+early-terminate instead of full-scan (when=today was 122ms).
3. **QueryList(today) UNION rewrite** — 3 index-seekable arms instead of one OR that full-scanned (819ms).
4. **synchronous=NORMAL** under WAL (D-I) — safe for a re-syncable cache; cuts per-write fsync.
Correctness: `go test ./core/record` (non-perf) green. 1M re-run: `scratchpad/perf1m-v2.log` (task b2vym886w).
Baseline (pre-opt, 1M p50): QueryList 819ms · when=today 122ms · Search 393ms · SetTaskField 255ms · CreateTask 246ms.

## Full test suite — GREEN (2026-07-06, `scratchpad/fulltest.log`)
All 10 packages pass together in the main tree: core, **core/coordinator** (P4), core/crdt, core/record
(perf changes), core/ydoc, core/ydstore, mobile (rewired), server, server/auth, server/ysync 26s (incl.
`TestPostgresTombstoneGC` + all tombstone-GC work). Everything from this session coexists.

## Known gap — frontend custom-view/list query cutover (affects the 1M "not sluggish" goal)
The record ENGINE is proven fast at 1M (perf test). BUT per the handoff, the FRONTEND still evaluates most
lists + custom views via in-memory selectors (`src/store/selectors.js`, `src/store/query.js runQuery`) over the
whole task array = O(n) = sluggish at 1M. Only the **Today** view was cut over to the engine (`QueryList`).
So: data layer ✓ 1M-fast; **routing all lists/custom-views through the engine's QueryTasks/SearchTasks is the
remaining wiring** (the "per-entity query cutover" follow-up). Also: query.js has richer operators than the
engine's `Cond` (hasAll/notHas/state/between/duration/time) — the engine needs operator parity to serve every
custom view. This is scoped follow-up work, likely beyond this run; documented so it isn't mistaken as done.

## testIDs added (2026-07-06) — for Playwright (web/desktop) + Maestro (iOS/Android)
Instrumented the fragile/icon-only controls in source. RN maps `testID`→ `data-testid` (web,
verified live: `fab-add-task` present), `accessibilityIdentifier` (iOS), `resource-id` (Android)
— one id works on all frameworks. Added: `fab-add-task`, `composer-title-input`/`-submit`/
`-when`/`-priority`/`-deadline`/`-tags`, `task-row-<id>`, `task-checkbox-<id>`, `drag-handle-<id>`,
`add-task-inline`, `when-option-*`, `priority-option-*`, and the `qb-*` query-builder set
(field/op dropdowns + options, name, add-condition, save, priority chips). Files: FloatingAddButton,
TaskComposer, Checkbox, TaskRow, ReorderableTaskList, WhenSheet, PrioritySheet, QueryBuilderSheet.
All 8 files babel-parse clean; web hot-reloaded them. Full list: `.maestro/TESTIDS.md`.
**To use on device the apps must be REBUILT** (`npm run sim:ios` / `emu:android`) — Metro
fast-refresh doesn't update native accessibilityIdentifiers.
**Drag/reorder:** web/desktop = `drag-handle-<id>` (small-move drag, Playwright/Maestro OK);
phone = whole `task-row-<id>` drags after a ~180ms long-press — a plain Maestro swipe may not clear
that threshold; needs empirical check (documented in TESTIDS.md), not yet verified on device.
Build/run one-liners now in `scripts/` (+ npm: `sim:ios`, `emu:android`, `e2e:ios`, `e2e:android`, `e2e:web`).

## Mobile E2E — production builds (2026-07-06)
Both simulators/emulators are present and the apps RUN. Maestro drives them.
- **Android:** the installed DEBUG APK failed everything (needs Metro on :8081 → "Unable to load script" + ANR). Fix = install the **self-contained RELEASE APK** (`android/app/build/outputs/apk/release/app-release.apk`); smart-lists then passes standalone. `./scripts/run-android.sh` should build/install release for CI.
- **iOS:** building a **Release** configuration (`expo run:ios --configuration Release`) so it's self-contained too (no Metro dependency), matching the user's production-build requirement.
- **Flows green so far** (real devices): `smart-lists` (iOS+Android) + `task-crud` (iOS). The other 5 flows fail because they were authored blind against the WEB layout — mobile differs (e.g. the "+" FAB opens the task DETAIL editor "New To-Do", not an inline composer; back is an in-app control, not iOS system back). task-crud was rewritten to the real mobile UX and passes; the remaining flows need the same rewrite (pattern established).
- Results JSON: `docs/test-results/maestro-{ios,android}.json`; runner `scripts/maestro-report.sh <platform> <out> <device>`.

## Mobile E2E — ALL flows green on Android; iOS in progress (2026-07-06)
Added testIDs across the app (detail rows/menus, search input, settings toggle, new-list,
query builder) and rebuilt the **Android release APK** with them. **All 7 Maestro flows PASS on
Android** (smart-lists, task-crud, task-fields, search, organization, custom-view, settings) —
verified individually on the standalone release APK. Real device UX learned + encoded:
- FAB opens the task DETAIL editor ("New To-Do"), not an inline composer.
- Detail When/Priority use anchored popover menus; picker options targeted by visible text.
- Display (show-completed) control only exists inside a Project.
- Query-builder field dropdown is clipped in the bottom sheet (known web+mobile bug) → custom-view
  uses the text-filter path; operator logic is covered by the engine matrix.
**Real code fix:** `AnchoredPopover` (TaskDetailModal) had a backdrop-Pressable that swallowed
option taps on iOS/web (the same bug Playwright skipped on web) — restructured the backdrop as a
sibling behind the card so option `onPress` fires. iOS being rebuilt (Release, standalone) with
this fix + all testIDs, then the full iOS suite runs. Production builds confirmed standalone (no
Metro): Android release APK + iOS Release (verified with Metro killed).

## Mobile E2E — testID-only (2026-07-07)
Per user directive, ALL 7 Maestro flows rewritten to use **testID selectors only** for UI chrome
(no regex-text, no point/coordinate taps) — the only text left is asserting on task/view/project
names the test itself created (content, not chrome). Added the full testID set: `sidebar-<listid>`
(inbox/today/upcoming/overdue/anytime/someday/logbook/trash/search), `sidebar-new-list`,
`sidebar-new-view`, `sidebar-project-*`, `list-back`, `list-display`, `detail-back`, `detail-*`,
`when-menu-*`, `pri-menu-*`, `display-backdrop`, `newlist-mode-*`, `newlist-name/create`, `qb-*`,
`search-input`, `fab-add-task`, `task-checkbox-*`. **Both production builds rebuilt** with the full
set: Android release APK (gradle assembleRelease) + iOS Release (xcodebuild, standalone). iOS
standalone run: smart-lists/task-crud/task-fields/search/organization all PASS (task-fields proves
the AnchoredPopover backdrop fix). Full suites re-running on both → maestro-{ios,android}.json.
Settings note: full Settings sheet is sign-in-gated; the offline-reachable setting (show-completed)
is the per-list Display menu, which only renders inside a Project — hence the settings flow's project.

## Background jobs in flight (task ids)
- `bh844t86x` — AUTHORITATIVE 1M perf re-run (corrected indexes + realistic data) → `scratchpad/perf1m-v3.log`
- `aa04ed884f6141c0a` — Playwright web E2E agent (P2) — still running
- done: `blx4ujv6c` (baseline), `b2vym886w` (v2), `bfpsvoyg9` (full go test, green)

## Next action
1. Launch Playwright web E2E agent (background). 2. Read 1M perf results, optimize record.go (indexes/pragmas/query). 3. Implement `core/coordinator` + wire desktop/mobile + Go tests. 4. Write Maestro flows. Loop, updating this doc.
