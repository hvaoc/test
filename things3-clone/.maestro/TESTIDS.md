# testIDs in the app (for Playwright + Maestro)

These `testID` props are now present in the source. React Native maps `testID` to:
`data-testid` on web (react-native-web → Playwright), `accessibilityIdentifier` on iOS,
and `resource-id` on Android (both → Maestro `id:` selectors). So the SAME id targets an
element on all three platforms.

- **Web/Playwright**: `page.getByTestId('fab-add-task')` (verified: `data-testid="fab-add-task"` renders).
- **Maestro (iOS/Android)**: `tapOn: { id: "fab-add-task" }`.

## Policy (2026-07-07): testID for chrome, data-value for content
Mobile flows target **all app chrome by testID** (buttons, menu options, headers, sheet
titles, field values, empty states) — never by user-visible text, because that text is
**localized** and would break translated builds. The ONLY strings a flow may match are
**values the test itself entered** (a task title / project name / tag it just typed):
those are test data, identical in every locale. See `.maestro/cases.json` + `flows/*.yaml`.

### Chrome testIDs added for this policy
`list-title` (ListScreen header), `search-empty` ("No to-dos match." state),
`deadline-remove` (DeadlineSheet remove control), `pri-check-<key>` (PriorityMenu selected
check — verifies priority persisted), `sheet-done` (BottomSheet Done button),
`search-back` (SearchScreen back), `detail-notes` (notes input), `tag-input`/`tag-add`
(TagSheet), `cal-day-<YYYY-MM-DD>` (MiniCalendar day cell; match the 15th via
`cal-day-.*-15`).

## Implemented testIDs
| testID | Element | File |
|--------|---------|------|
| `fab-add-task` | Floating "+" create button | `FloatingAddButton.js` |
| `composer-title-input` | Task name input | `TaskComposer.js` |
| `composer-submit` | "Add task" submit | `TaskComposer.js` |
| `composer-when` / `composer-deadline` / `composer-priority` / `composer-tags` | composer field chips | `TaskComposer.js` |
| `task-row-<id>` | a task's row container | `TaskRow.js` |
| `task-checkbox-<id>` | a task's complete/reopen checkbox | `TaskRow.js` → `Checkbox.js` |
| `drag-handle-<id>` | reorder grip (web/desktop handled layout) | `ReorderableTaskList.js` |
| `add-task-inline` | inline "+ Add task" row in a project | `ReorderableTaskList.js` |
| `when-option-today` / `when-option-evening` / `when-option-someday` | When picker options | `WhenSheet.js` |
| `priority-option-<key>` / `priority-option-none` | Priority picker options | `PrioritySheet.js` |
| `qb-name` | custom-view name input | `QueryBuilderSheet.js` |
| `qb-field` / `qb-field-<key>` | condition field dropdown + its options | `QueryBuilderSheet.js` |
| `qb-op` / `qb-op-<key>` | condition operator dropdown + its options | `QueryBuilderSheet.js` |
| `qb-priority-<key>` | condition priority-value chips | `QueryBuilderSheet.js` |
| `qb-add-condition` | "Add condition" | `QueryBuilderSheet.js` |
| `qb-save` | "Save View" / "Apply" | `QueryBuilderSheet.js` |

## Drag & drop (reorder)
- **Web / desktop (handled layout):** the reorder grip is `drag-handle-<id>`; a small move
  drags (`Gesture.Pan().activeOffsetY`). Playwright `dragTo` / Maestro `swipe` from that id works.
- **Phone (touch):** the WHOLE row drags after a **long-press (~180ms)**
  (`Gesture.Pan().activateAfterLongPress(180)`), targeting `task-row-<id>`. A plain Maestro
  `swipe` moves immediately and may not clear the long-press threshold; verify empirically —
  if it can't, document it (and consider exposing a `drag-handle` on touch too).

## Still un-instrumented (add if a test needs them)
Sidebar list entries (text works: `.*Today`), TaskDetailModal field controls
(When/Priority/Deadline/Tags/Delete), NewListSheet (Project/Custom View/Create),
SettingsSheet "Show completed". Follow the same `testID=` pattern.
