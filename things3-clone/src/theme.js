// Things 3 inspired color palette and spacing tokens.
// Things' signature look: lots of white space, a soft blue accent, muted greys,
// and colorful list "dots" for the smart lists.

export const colors = {
  // Surfaces
  background: '#ffffff',
  groupedBackground: '#f5f6f8',
  card: '#ffffff',
  separator: '#ececec',
  separatorStrong: '#dcdde0',

  // Text
  text: '#1c1c1e',
  textSecondary: '#8a8a8e',
  textTertiary: '#b8b8bd',
  placeholder: '#bfbfc4',

  // The Things blue accent
  accent: '#2b6fff',
  accentSoft: '#e8f0ff',

  // Smart list colors (the little glyph tints in the sidebar)
  inbox: '#5b6b7b',
  today: '#f5c518',
  upcoming: '#e8554e',
  overdue: '#d0342c',
  anytime: '#1f9d55',
  someday: '#c39a3f',
  logbook: '#1f9d55',
  trash: '#9a9aa0',

  // Status
  deadline: '#e8554e',
  deadlineSoon: '#f5a623',
  checkboxDone: '#2b6fff',
  white: '#ffffff',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
};

export const typography = {
  largeTitle: { fontSize: 34, fontWeight: '700' },
  title: { fontSize: 24, fontWeight: '700' },
  heading: { fontSize: 17, fontWeight: '600' },
  body: { fontSize: 16, fontWeight: '400' },
  callout: { fontSize: 15, fontWeight: '400' },
  subhead: { fontSize: 14, fontWeight: '400' },
  caption: { fontSize: 12, fontWeight: '400' },
};
