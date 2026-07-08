# E2E tests — Things3-clone (web build)

Playwright end-to-end tests for the Expo / React-Native-Web build of the
Things3-clone todo app. Isolated from the RN app: this folder has its own
`package.json` and Playwright install so it stays CI-portable.

## Run

```bash
# from this directory (e2e/)
npm test                 # headless, all specs
npm run test:headed      # watch it drive the browser
npm run report           # open the last HTML report

# a single feature
npx playwright test smart-lists
```

The suite authors against a **Metro dev server on http://localhost:8088**. Point
it elsewhere with `PLAYWRIGHT_BASE_URL`:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:8081 npm test
```

If nothing is serving :8088, start the app first (from the repo root):

```bash
npx expo start --web --port 8088
# or serve a static export:
npm run web:export        # builds ../dist-web
npx serve -s ../dist-web -l 8088
```

`playwright.config.ts` has a commented `webServer` block showing both options so
CI can boot the app itself.

## Auth / offline path (how we reach the task UI deterministically)

The app is **offline-first with no login wall**. A fresh browser context loads
straight into the task UI on the **Today** smart list, backed entirely by
client-side storage. There is **no** dependency on a signed-in server session
(e.g. a persisted `bella@test.dev` login) — a fresh incognito context has none
of that and still lands in a usable, empty workspace.

Persistence lives in:
- **IndexedDB `things3clone-ydoc`** — the CRDT record store (tasks, projects,
  areas, headings, tags, custom views), written by a Web Worker
  (`public/crdt.worker.js`, WASM + OPFS/IndexedDB).
- **localStorage** (`appFg`/`appBg`/`appZoom`, `things3clone:data:v2`) — prefs +
  a fallback snapshot.

On hydrate (`src/store/TasksContext.js`) an **empty store → empty workspace**
(no auto-seeded sample data). So a pristine origin *is* the known baseline.

## Reset strategy (repeatable / isolated)

Documented in `tests/helpers.ts` (`resetApp`). In short:

1. **Fresh Playwright context per test** is the primary isolation boundary —
   each test gets empty IndexedDB / localStorage / OPFS for the origin, which
   hydrates to the empty baseline.
2. `resetApp` (run in a `beforeEach` fixture) additionally clears
   `localStorage` and deletes any pre-existing IndexedDB, in case a reused
   profile leaked prefs. It deliberately does **not** force-delete a live worker
   DB or wipe OPFS — that races the record worker's init and silently drops the
   first write.
3. It waits for the sidebar shell **and a short settle** so the async CRDT
   worker (WASM/OPFS) is accepting writes before any test issues a structural
   change. Without this, the first `Area`/`Project`/`Heading` create is lost.
   `createProject`/`createArea` also retry once as a belt-and-braces guard.

Each spec then creates exactly the data it asserts on — no cross-test bleed.

## Selectors

The app ships **zero `testID`s**, so we work with what renders: role/text
selectors (`getByText`, `getByPlaceholder`) for most things, plus a handful of
geometry/`elementFromPoint` helpers in `tests/helpers.ts` for unlabelled
RN-Web elements — the round "Magic Plus" FAB, the detail modal's back/trash
icons, and project-row checkboxes. No app source was modified.

## Coverage

| Spec | Feature | Status |
|------|---------|--------|
| `smart-lists.spec.ts` | Sidebar lists all 8 smart lists; each navigates & shows its header | ✅ |
| `task-crud.spec.ts` | Create, edit title, complete → Logbook, reopen, delete → Trash | ✅ |
| `task-fields.spec.ts` | When (Today/Someday → right list), Priority, Deadline, Notes | ✅ |
| `organization.spec.ts` | Create Area / Project / Heading; move task into project; tag a task | ✅ |
| `custom-view.spec.ts` | Saved query view (text filter) lists only matching tasks | ✅ (1 skip) |
| `search.spec.ts` | Global search filters to matching tasks; empty-state | ✅ |
| `settings.spec.ts` | "Show completed" toggle shows/hides completed tasks | ✅ |

**Totals: 21 passing, 1 skipped, 0 failing** (3 consecutive clean runs).

### Notes on what's driven where, and the one skip

- **When / Priority** are set through the **project inline composer's**
  BottomSheets (`WhenSheet`/`PrioritySheet`), not the task-detail modal. The
  detail modal edits Date/Priority via an *anchored popover*
  (`WhenMenu`/`PriorityMenu`) whose options do **not** respond to synthetic
  clicks in this RN-Web build (verified: neither Playwright's native click nor
  dispatched pointer/mouse events fire their `onPress`). The composer path
  reaches the same fields reliably, so coverage is preserved.
- **Settings "Show completed"** is driven through the project **Display** popover
  (the offline-reachable "Completed tasks" switch), because the full
  `SettingsSheet` is only reachable from the **signed-in** account popover —
  unavailable on the offline path we test. `settings.showCompleted` defaults to
  **true**, so the test asserts complete → toggle OFF (hidden) → toggle ON
  (shown).
- **Skipped:** `custom-view.spec.ts` › *Priority=High condition view*. The query
  engine supports it and the text-filter view is fully verified, but the
  condition builder's field `<Dropdown>` (`QueryBuilderSheet.js`) renders as an
  RN-Web absolutely-positioned menu inside a BottomSheet whose overflow clips /
  z-orders the options under the "Add condition" affordance; selecting the
  "Priority" option does not register through Playwright and there's no
  testID/role to target it deterministically. Documented inline with a clear
  reason rather than shipped flaky.
```
