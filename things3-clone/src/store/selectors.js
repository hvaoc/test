import { WHEN, STATUS } from './constants';
import { todayKey, isPast, isFuture, isToday } from '../utils/date';

// ---------------------------------------------------------------------------
// Predicate helpers
// ---------------------------------------------------------------------------

export const isOpen = (t) => t.status === STATUS.OPEN;
export const isLogged = (t) =>
  t.status === STATUS.COMPLETED || t.status === STATUS.CANCELED;
export const isTrashed = (t) => t.status === STATUS.TRASHED;

// Manual sort order (drag-to-reorder writes this). Falls back to 0 so tasks
// predating the field keep a stable position.
export const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

// Is this task scheduled for "today or earlier" (i.e. it should surface in Today)?
function isDueToday(t) {
  if (t.when === WHEN.TODAY || t.when === WHEN.EVENING) return true;
  // A concrete date in the past or equal to today rolls into Today.
  if (t.when && t.when !== WHEN.SOMEDAY && (isToday(t.when) || isPast(t.when))) {
    return true;
  }
  // A deadline that's reached/overdue also pulls a task into Today.
  if (t.deadline && (isToday(t.deadline) || isPast(t.deadline))) return true;
  return false;
}

function isScheduledFuture(t) {
  return (
    t.when &&
    t.when !== WHEN.TODAY &&
    t.when !== WHEN.EVENING &&
    t.when !== WHEN.SOMEDAY &&
    isFuture(t.when)
  );
}

const isSomeday = (t) => t.when === WHEN.SOMEDAY;
const hasContainer = (t) => Boolean(t.projectId || t.areaId);
// Top-level tasks only — subtasks (parentId set) are shown nested under their
// parent, never as standalone rows in the smart lists / project groupings.
const isTopLevel = (t) => !t.parentId;

// A task's direct child tasks, in manual order.
export function selectSubtasks(tasks, parentId) {
  return tasks.filter((t) => t.parentId === parentId && !isTrashed(t)).sort(byOrder);
}

// ---------------------------------------------------------------------------
// Smart-list selectors. Each returns the tasks belonging in that built-in list.
// ---------------------------------------------------------------------------

// Inbox: open tasks that haven't been organized into a project/area and aren't
// scheduled or filed away.
export function selectInbox(tasks) {
  return tasks
    .filter((t) => isOpen(t) && isTopLevel(t) && !hasContainer(t) && !t.when)
    .sort(byOrder);
}

// Today: everything due today or overdue (the heart of Things). Sorted by the
// manual `order` so drag-to-reorder persists.
export function selectToday(tasks) {
  return tasks.filter((t) => isOpen(t) && isTopLevel(t) && isDueToday(t)).sort(byOrder);
}

// Upcoming: open tasks scheduled for a future date (grouped by date in the UI).
export function selectUpcoming(tasks) {
  return tasks
    .filter((t) => isOpen(t) && isTopLevel(t) && isScheduledFuture(t))
    .sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0));
}

// Overdue: open tasks whose scheduled date or deadline is strictly in the past.
// (These also surface in Today, which shows "due today or overdue".)
const overdueKey = (t) => {
  const w =
    t.when && ![WHEN.SOMEDAY, WHEN.TODAY, WHEN.EVENING].includes(t.when) && isPast(t.when)
      ? t.when
      : null;
  const d = t.deadline && isPast(t.deadline) ? t.deadline : null;
  return w && d ? (w < d ? w : d) : w || d;
};
export function selectOverdue(tasks) {
  return tasks
    .filter((t) => isOpen(t) && isTopLevel(t) && overdueKey(t) != null)
    .sort((a, b) => {
      const ka = overdueKey(a), kb = overdueKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

// Anytime: open, available-now tasks that live in a project or area (not Inbox,
// not Someday, not scheduled for the future).
export function selectAnytime(tasks) {
  return tasks
    .filter(
      (t) =>
        isOpen(t) &&
        isTopLevel(t) &&
        !isSomeday(t) &&
        !isScheduledFuture(t) &&
        (hasContainer(t) || isDueToday(t))
    )
    .sort(byOrder);
}

// Someday: tasks deliberately deferred with no date.
export function selectSomeday(tasks) {
  return tasks.filter((t) => isOpen(t) && isTopLevel(t) && isSomeday(t)).sort(byOrder);
}

// Logbook: completed & canceled tasks, newest first.
export function selectLogbook(tasks) {
  return tasks
    .filter(isLogged)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
}

export function selectTrash(tasks) {
  return tasks.filter(isTrashed);
}

// Tasks belonging to a specific project (open + recently completed shown inline).
export function selectProjectTasks(tasks, projectId) {
  return tasks.filter(
    (t) => t.projectId === projectId && !isTrashed(t)
  );
}

// Tasks filed directly under an area (not via a project).
export function selectAreaTasks(tasks, areaId) {
  return tasks
    .filter((t) => t.areaId === areaId && !t.projectId && !isTrashed(t))
    .sort(byOrder);
}

// ---------------------------------------------------------------------------
// Badge counts for the sidebar.
// ---------------------------------------------------------------------------
export function counts(tasks) {
  return {
    inbox: selectInbox(tasks).length,
    today: selectToday(tasks).length,
    overdue: selectOverdue(tasks).length,
  };
}

export function selectForList(tasks, listId) {
  switch (listId) {
    case 'inbox':
      return selectInbox(tasks);
    case 'today':
      return selectToday(tasks);
    case 'upcoming':
      return selectUpcoming(tasks);
    case 'overdue':
      return selectOverdue(tasks);
    case 'anytime':
      return selectAnytime(tasks);
    case 'someday':
      return selectSomeday(tasks);
    case 'logbook':
      return selectLogbook(tasks);
    case 'trash':
      return selectTrash(tasks);
    default:
      return [];
  }
}

export { todayKey };
