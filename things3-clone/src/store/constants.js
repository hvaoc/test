import { colors } from '../theme';

// The built-in "smart lists" that live at the top of the Things sidebar.
// Each has an id used throughout the app, an Ionicons glyph and a tint color.
// `outline: true` draws the glyph as an outline in the list's color (no filled
// tile). Today keeps the filled star.
export const SMART_LISTS = [
  { id: 'inbox', title: 'Inbox', icon: 'file-tray-outline', color: colors.accent, outline: true },
  { id: 'today', title: 'Today', icon: 'star', color: colors.today, outline: true },
  { id: 'upcoming', title: 'Upcoming', icon: 'calendar-outline', color: colors.upcoming, outline: true },
  { id: 'overdue', title: 'Overdue', icon: 'alert-circle-outline', color: colors.overdue, outline: true },
  { id: 'anytime', title: 'Anytime', icon: 'layers-outline', color: colors.anytime, outline: true },
  { id: 'someday', title: 'Someday', icon: 'archive-outline', color: colors.someday, outline: true },
  { id: 'logbook', title: 'Logbook', icon: 'checkmark-done-circle-outline', color: colors.logbook, outline: true },
  { id: 'trash', title: 'Trash', icon: 'trash-outline', color: colors.trash, outline: true },
];

export const SMART_LIST_MAP = SMART_LISTS.reduce((acc, l) => {
  acc[l.id] = l;
  return acc;
}, {});

// A task's "when" can be one of these scheduling buckets, or a concrete
// "YYYY-MM-DD" date string.
export const WHEN = {
  TODAY: 'today',
  EVENING: 'evening', // "This Evening" — shown under Today in a dimmed section
  SOMEDAY: 'someday',
  // anything else is treated as a calendar date string
};

export const STATUS = {
  OPEN: 'open',
  COMPLETED: 'completed',
  CANCELED: 'canceled',
  TRASHED: 'trashed',
};

// Task priority levels (highest first).
export const PRIORITIES = [
  { key: 'high', label: 'High', color: '#c04f43' },
  { key: 'medium', label: 'Medium', color: '#de8d35' },
  { key: 'low', label: 'Low', color: '#3b6ed9' },
];

export const PRIORITY_MAP = PRIORITIES.reduce((acc, p) => {
  acc[p.key] = p;
  return acc;
}, {});

// Palette offered when creating a project / area.
export const PROJECT_COLORS = [
  '#2b6fff', '#4a90e2', '#00b8d4', '#16a4a4', '#00897b', '#1f9d55',
  '#43a047', '#7cb342', '#f5a623', '#fb8c00', '#ff8c42', '#e8554e',
  '#d81b60', '#e84393', '#c0399f', '#9b59b6', '#6c5ce7', '#3949ab',
  '#8d6e63', '#546e7a', '#5b6b7b', '#37474f',
];
