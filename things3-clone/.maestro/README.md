# Maestro mobile E2E flows (iOS + Android)

Repeatable UI flows for the React-Native app, one YAML per feature group. Maestro drives
the SAME app on both platforms (`appId: com.functionofq.thingsclone`), so these cover iOS
**and** Android from one suite.

## Status (be honest)
These flows are **CI-ready artifacts but were NOT executed** in the authoring environment:
it had no iOS Simulator (Xcode not installed — Command Line Tools only) and no Android
emulator/SDK. They encode the intended user journeys from the feature inventory
(`docs/autonomous-status.md`). On their **first real run** the selectors must be reconciled
against the built app — see the caveat below.

## ⚠️ Selector caveat — the app has NO testIDs
The RN source currently exposes **zero `testID`s** and only one `accessibilityLabel`
("Open/close sidebar"). Maestro matches on visible text, which works for labelled items
(Inbox, Today, "Add task", "Task name" placeholder, …) but is fragile for icon-only
controls (the "+" floating button, checkboxes, badges). **Strong recommendation:** add
`testID` (RN) props to the key controls listed in `TESTIDS.md`, then switch the fragile
`tapOn: text/point` steps to `tapOn: { id: ... }`. Until then, steps marked `# FRAGILE`
are best-effort and may need adjustment on first run.

## Running (where a device/emulator exists)
```bash
# 1. install Maestro:  curl -fsSL https://get.maestro.mobile.dev | bash
# 2. build + install the app on a booted simulator/emulator:
#      npx expo run:ios      # or: npx expo run:android
# 3. run the whole suite:
maestro test .maestro/flows
# or one flow:
maestro test .maestro/flows/task-crud.yaml
```
`clearState: true` in each flow's `launchApp` gives test isolation (fresh app data per
flow), so the suite is repeatable and order-independent — suitable for CI
(`maestro test --format junit .maestro/flows`).

## Coverage (mirrors the web Playwright suite in `e2e/`)
| Flow | Feature |
|------|---------|
| `smart-lists.yaml` | 8 smart lists (Inbox/Today/Upcoming/Overdue/Anytime/Someday/Logbook/Trash) |
| `task-crud.yaml` | create, complete→Logbook, reopen, delete→Trash |
| `task-fields.yaml` | When / Deadline / Priority / Notes; scheduling moves the task |
| `organization.yaml` | Area, Project, Heading, Tag, Move |
| `custom-view.yaml` | query-builder saved filter with operators |
| `search.yaml` | full-text title search |
| `settings.yaml` | toggle "Show completed" |
