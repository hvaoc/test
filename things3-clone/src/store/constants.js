import { colors } from '../theme';

// The built-in "smart lists" that live at the top of the Things sidebar.
// Each has an id used throughout the app, an Ionicons glyph and a tint color.
export const SMART_LISTS = [
  { id: 'inbox', title: 'Inbox', icon: 'mail', color: colors.inbox },
  { id: 'today', title: 'Today', icon: 'star', color: colors.today },
  { id: 'upcoming', title: 'Upcoming', icon: 'calendar', color: colors.upcoming },
  { id: 'anytime', title: 'Anytime', icon: 'layers', color: colors.anytime },
  { id: 'someday', title: 'Someday', icon: 'archive', color: colors.someday },
  { id: 'logbook', title: 'Logbook', icon: 'checkmark-done-circle', color: colors.logbook },
  { id: 'trash', title: 'Trash', icon: 'trash', color: colors.trash },
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
  '#2b6fff', '#e8554e', '#1f9d55', '#f5a623',
  '#9b59b6', '#16a4a4', '#e84393', '#5b6b7b',
];
