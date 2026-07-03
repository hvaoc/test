# Things Clone

A polished, offline-first **Things 3 clone** built with **Expo** and **React
Native**. It recreates the calm, white-space-heavy Things aesthetic and its
core organizing model — smart lists, areas, projects, headings, checklists,
tags, scheduling ("when") and deadlines.

> This lives in its own folder (`things3-clone/`) and is independent of the
> PlayMap prototype in the repo root.

## Features

**Smart lists**
- **Inbox** — unsorted, unscheduled to-dos
- **Today** — everything due today or overdue, with a dimmed *This Evening* group
- **Upcoming** — future to-dos grouped by date
- **Anytime** — available work across all projects
- **Someday** — deferred ideas with no date
- **Logbook** — completed & canceled to-dos, grouped by month
- **Trash** — soft-deleted to-dos, with *Empty Trash*

**Organizing**
- **Areas** (e.g. Work, Personal) containing **Projects**
- **Projects** with editable title, notes, deadline, a progress pie, and **Headings**
- **Move** a to-do into Inbox / an Area / a Project

**To-do editing** (full-screen editor)
- Title, multi-line notes
- **Checklist** items (add / rename / check / delete)
- **Tags** with inline creation
- **When** scheduler — Today, This Evening, Someday, or a calendar date
- **Deadline** — hard due date (red flag), highlighted when overdue
- Complete, cancel, or trash

**Niceties**
- Local persistence via AsyncStorage (debounced writes)
- Seeded sample data on first launch
- "Magic Plus" floating button that adds a to-do in the current list's context
- A custom mini-calendar (no extra date-picker dependency)

## Run

```bash
cd things3-clone
npm install
npm start          # then press i (iOS), a (Android), or w (web)
```

Requires the [Expo](https://docs.expo.dev/) toolchain. The app runs in Expo Go
or a dev build; no backend or accounts needed.

## Architecture

```
App.js                     Providers (gesture handler, safe area, store, navigation)
src/
  theme.js                 Colors, spacing, radius, typography tokens
  navigation/              Native-stack: Home (sidebar) → List
  screens/
    HomeScreen.js          The Things sidebar: smart lists + areas + projects
    ListScreen.js          Renders any context (smart list / area / project) with grouped sections
  components/
    TaskRow.js             A to-do row with metadata badges
    TaskDetailModal.js     Full-screen to-do editor + attribute toolbar
    ProjectHeader.js       Editable project header (title, notes, progress, deadline)
    MiniCalendar.js        Dependency-free month grid
    WhenSheet / DeadlineSheet / MoveSheet / TagSheet / NewListSheet   Bottom-sheet pickers
    Checkbox.js, BottomSheet.js, FloatingAddButton.js
  store/
    TasksContext.js        useReducer store + action creators + persistence wiring
    selectors.js           Smart-list filtering logic (the domain rules)
    constants.js           Smart-list defs, WHEN/STATUS enums, palettes
    sampleData.js          First-run seed content
    storage.js             AsyncStorage load/save/clear
  utils/
    date.js                Timezone-safe "YYYY-MM-DD" helpers & relative labels
    id.js                  Lightweight id generator
```

### Data model

- **Task**: `{ id, title, notes, checklist[], tags[], when, deadline, projectId, areaId, headingId, status, createdAt, completedAt }`
- **Project**: `{ id, name, notes, areaId, color, deadline, status }`
- **Area**: `{ id, name, color }`
- **Heading**: `{ id, projectId, title }`

`when` is one of `today` / `evening` / `someday` / a `YYYY-MM-DD` date / `null`.
`status` is `open` / `completed` / `canceled` / `trashed`. The smart lists are
pure functions of the task list (see `selectors.js`), so they always stay in
sync with no manual bookkeeping.

## Checkpoints (git tags)

Stable points to roll back to if a large change regresses something. Restore
with `git checkout <tag>` (or `git reset --hard <tag>`).

- **`pre-virtualization`** — before any list windowing (baseline perf work).
- **`pre-board-gantt-virtualization`** — all *list* surfaces virtualized and
  stable; Board & Gantt still render every row up front. Checkpoint taken right
  before virtualizing those two views.

## Notes & limitations

This is a faithful single-device prototype, not a full Things replacement. Not
implemented: cloud sync, repeating to-dos, reminders/notifications,
drag-to-reorder, the Quick Find search, and the "Today list" calendar-event
integration. The architecture leaves room for each.
