// Theme system.
//
// The app is themed via CSS custom properties on the web/desktop build: every
// themed color token is exposed as `var(--c-<token>, <light fallback>)`, so a
// single set of StyleSheets reflows instantly when we swap the variables — no
// per-component refactor. On native there is no CSS, so the static Light palette
// is used (theme switching is a web/desktop feature).
//
// A theme is always TWO-TONE: a sidebar surface (`groupedBackground`) against a
// content surface (`background`), plus a matching accent. Light-family themes use
// dark text on light(-tinted) surfaces; dark-family themes use light text on
// dark(-tinted) surfaces.

import { Platform } from 'react-native';

const isWeb = Platform.OS === 'web' && typeof document !== 'undefined';

// Multiply a #rrggbb color's channels by `f` (<1 darkens, >1 lightens).
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${ch(((n >> 16) & 255) * f)}${ch(((n >> 8) & 255) * f)}${ch((n & 255) * f)}`;
};

// Themed tokens (driven by CSS variables). Everything else in `colors` is a
// constant shared by every theme (smart-list dots, status reds, white).
const TOKENS = [
  'background',
  'groupedBackground',
  // A subtle secondary surface on the CONTENT side (tag chips, pressed rows, the
  // task-detail properties panel, calendar cells…). Distinct from
  // `groupedBackground`, which is the (possibly strongly colored) sidebar.
  'surfaceMuted',
  // The task-detail properties panel surface. Equals the sidebar surface for most
  // themes; the "deep" class uses a slightly darker shade of the content pane
  // instead (so the strong sidebar color isn't repeated on the right).
  'panelSurface',
  'card',
  'separator',
  'separatorStrong',
  'text',
  'textSecondary',
  'textTertiary',
  'placeholder',
  'accent',
  'accentSoft',
  'checkboxDone',
  // Sidebar-specific tokens. Most themes set these equal to their content
  // equivalents, but the "deep" class uses a strongly colored sidebar against a
  // light content pane, so the sidebar needs its own (light) text + highlights.
  'sidebarText',
  'sidebarTextSecondary',
  'sidebarTextTertiary',
  'sidebarHover',
  'sidebarSelected',
  'sidebarSeparator',
];

// Constant across all themes — the colorful smart-list glyphs and status colors.
const CONSTANT = {
  inbox: '#5b6b7b',
  today: '#f5c518',
  upcoming: '#e8554e',
  overdue: '#d0342c',
  anytime: '#1f9d55',
  someday: '#c39a3f',
  logbook: '#1f9d55',
  trash: '#9a9aa0',
  deadline: '#e8554e',
  deadlineSoon: '#f5a623',
  white: '#ffffff',
};

// ---- Palettes -------------------------------------------------------------

// Light (the app's original look) — also the CSS-variable fallbacks.
const LIGHT = {
  background: '#ffffff',
  groupedBackground: '#f5f6f8',
  surfaceMuted: '#f5f6f8',
  panelSurface: '#f5f6f8',
  card: '#ffffff',
  separator: '#ececec',
  separatorStrong: '#dcdde0',
  text: '#1c1c1e',
  textSecondary: '#8a8a8e',
  textTertiary: '#b8b8bd',
  placeholder: '#bfbfc4',
  accent: '#2b6fff',
  accentSoft: '#e8f0ff',
  checkboxDone: '#2b6fff',
  sidebarText: '#1c1c1e',
  sidebarTextSecondary: '#8a8a8e',
  sidebarTextTertiary: '#b8b8bd',
  sidebarHover: 'rgba(0,0,0,0.045)',
  sidebarSelected: '#e8f0ff',
  sidebarSeparator: '#ececec',
};

const DARK = {
  background: '#1e1e20',
  groupedBackground: '#161618',
  surfaceMuted: '#2b2b2f',
  panelSurface: '#161618',
  card: '#262629',
  separator: 'rgba(255,255,255,0.09)',
  separatorStrong: 'rgba(255,255,255,0.16)',
  text: '#ececed',
  textSecondary: '#9a9aa0',
  textTertiary: '#6d6d72',
  placeholder: '#6d6d72',
  accent: '#4c86ff',
  accentSoft: '#22344f',
  checkboxDone: '#4c86ff',
  sidebarText: '#ececed',
  sidebarTextSecondary: '#9a9aa0',
  sidebarTextTertiary: '#6d6d72',
  sidebarHover: 'rgba(255,255,255,0.06)',
  sidebarSelected: '#22344f',
  sidebarSeparator: 'rgba(255,255,255,0.09)',
};

// A colorful LIGHT-family theme: tinted sidebar + near-white content, dark text.
// The sidebar shares the (dark) content text since both surfaces are light.
const lightFamily = ({ sidebar, content = '#ffffff', accent, accentSoft }) => ({
  background: content,
  groupedBackground: sidebar,
  surfaceMuted: 'rgba(0,0,0,0.05)',
  panelSurface: sidebar,
  // Elevated overlay surface (popovers, sheets, the Settings dialog): a slightly
  // brighter tint of the content so overlays follow the theme instead of being a
  // flat pure white.
  card: shade(content, 1.03),
  separator: 'rgba(0,0,0,0.07)',
  separatorStrong: 'rgba(0,0,0,0.13)',
  text: '#1c1c1e',
  textSecondary: '#7c7c82',
  textTertiary: '#aeaeb4',
  placeholder: '#bcbcc2',
  accent,
  accentSoft,
  checkboxDone: accent,
  sidebarText: '#1c1c1e',
  sidebarTextSecondary: '#7c7c82',
  sidebarTextTertiary: '#aeaeb4',
  sidebarHover: 'rgba(0,0,0,0.05)',
  sidebarSelected: accentSoft,
  sidebarSeparator: 'rgba(0,0,0,0.07)',
});

// A colorful DARK-family theme: tinted-dark sidebar + content, light text.
const darkFamily = ({ sidebar, content, card, accent, accentSoft }) => ({
  background: content,
  groupedBackground: sidebar,
  surfaceMuted: 'rgba(255,255,255,0.07)',
  panelSurface: sidebar,
  card,
  separator: 'rgba(255,255,255,0.08)',
  separatorStrong: 'rgba(255,255,255,0.15)',
  text: '#eceef2',
  textSecondary: '#9aa0ad',
  textTertiary: '#6b7180',
  placeholder: '#6b7180',
  accent,
  accentSoft,
  checkboxDone: accent,
  sidebarText: '#eceef2',
  sidebarTextSecondary: '#9aa0ad',
  sidebarTextTertiary: '#6b7180',
  sidebarHover: 'rgba(255,255,255,0.06)',
  sidebarSelected: accentSoft,
  sidebarSeparator: 'rgba(255,255,255,0.08)',
});

// The "deep" class: a strongly colored (dark) sidebar against a very light shade
// of the same hue for the content pane. Light text on the sidebar, dark text on
// the content.
const deepFamily = ({ sidebar, content, accent, accentSoft }) => ({
  background: content,
  groupedBackground: sidebar,
  surfaceMuted: 'rgba(0,0,0,0.06)',
  // A slightly darker shade of the content pane — not the strong sidebar color.
  panelSurface: shade(content, 0.93),
  // Elevated overlay surface: a brighter tint of the content, so popovers and the
  // Settings dialog follow the theme instead of being a flat pure white.
  card: shade(content, 1.03),
  separator: 'rgba(0,0,0,0.07)',
  separatorStrong: 'rgba(0,0,0,0.13)',
  text: '#20222c',
  textSecondary: '#6c6f7a',
  textTertiary: '#a2a5b0',
  placeholder: '#b0b3bd',
  accent,
  accentSoft,
  checkboxDone: accent,
  sidebarText: '#f2f4fb',
  sidebarTextSecondary: 'rgba(255,255,255,0.66)',
  sidebarTextTertiary: 'rgba(255,255,255,0.42)',
  sidebarHover: 'rgba(255,255,255,0.08)',
  sidebarSelected: 'rgba(255,255,255,0.16)',
  sidebarSeparator: 'rgba(255,255,255,0.13)',
});

// The theme catalog. `system` follows the OS light/dark preference. Each entry
// carries a `swatch` (sidebar + content + accent) for the picker.
export const THEMES = [
  { id: 'system', name: 'System', system: true },
  { id: 'light', name: 'Light', mode: 'light', palette: LIGHT },
  { id: 'dark', name: 'Dark', mode: 'dark', palette: DARK },
  {
    id: 'tangerine',
    name: 'Tangerine',
    mode: 'light',
    palette: lightFamily({ sidebar: '#fbeede', content: '#fffbf7', accent: '#e8730c', accentSoft: '#f8ddc4' }),
  },
  {
    id: 'kale',
    name: 'Kale',
    mode: 'light',
    palette: lightFamily({ sidebar: '#e6f2e8', content: '#f8fcf9', accent: '#2f8f4e', accentSoft: '#d3ecda' }),
  },
  {
    id: 'blueberry',
    name: 'Blueberry',
    mode: 'light',
    palette: lightFamily({ sidebar: '#e8eefb', content: '#f8faff', accent: '#3a5bd9', accentSoft: '#dbe3fb' }),
  },
  {
    id: 'lavender',
    name: 'Lavender',
    mode: 'light',
    palette: lightFamily({ sidebar: '#efeafb', content: '#faf8ff', accent: '#7a54cf', accentSoft: '#e6dcf9' }),
  },
  {
    id: 'rose',
    name: 'Rose',
    mode: 'light',
    palette: lightFamily({ sidebar: '#fce8ef', content: '#fff8fb', accent: '#d6467a', accentSoft: '#f8d9e4' }),
  },
  {
    id: 'midnight',
    name: 'Midnight',
    mode: 'dark',
    palette: darkFamily({ sidebar: '#12162a', content: '#171d33', card: '#1e2542', accent: '#5b8cff', accentSoft: '#233258' }),
  },
  {
    id: 'forest',
    name: 'Forest',
    mode: 'dark',
    palette: darkFamily({ sidebar: '#0f1c15', content: '#152318', card: '#1b2c20', accent: '#4bbf78', accentSoft: '#1d3626' }),
  },
  // "Deep" class — bold colored sidebar, very light same-hue content.
  {
    id: 'navy',
    name: 'Navy',
    mode: 'light',
    palette: deepFamily({ sidebar: '#1e2a55', content: '#eef1fb', accent: '#3a5bd9', accentSoft: '#dde3fa' }),
  },
  {
    id: 'pine',
    name: 'Pine',
    mode: 'light',
    palette: deepFamily({ sidebar: '#123a2e', content: '#ecf6f1', accent: '#12946a', accentSoft: '#d2ece1' }),
  },
  {
    id: 'plum',
    name: 'Plum',
    mode: 'light',
    palette: deepFamily({ sidebar: '#361f52', content: '#f4eefb', accent: '#8a4fd0', accentSoft: '#e6daf6' }),
  },
  {
    id: 'espresso',
    name: 'Espresso',
    mode: 'light',
    palette: deepFamily({ sidebar: '#382a1e', content: '#f8f3ec', accent: '#b5762e', accentSoft: '#ead9c3' }),
  },
  {
    id: 'crimson',
    name: 'Crimson',
    mode: 'light',
    palette: deepFamily({ sidebar: '#4a1f29', content: '#fbeef1', accent: '#d6455f', accentSoft: '#f5d7dd' }),
  },
  {
    id: 'teal',
    name: 'Teal',
    mode: 'light',
    palette: deepFamily({ sidebar: '#0e3a40', content: '#ecf6f7', accent: '#0f8f9e', accentSoft: '#d0ebee' }),
  },
];

const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === 'light');

// The palette a theme id resolves to right now ('system' consults the OS).
export function resolvePalette(id) {
  const t = themeById(id);
  if (t.system) {
    const prefersDark = isWeb && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? DARK : LIGHT;
  }
  return t.palette;
}

export function resolveMode(id) {
  const t = themeById(id);
  if (t.system) {
    const prefersDark = isWeb && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  }
  return t.mode;
}

// ---- Live theme (web) -----------------------------------------------------

const KEY = 'appTheme';
const listeners = new Set();
let mediaQuery = null;

const cssVar = (k) => `--c-${k}`;

// `colors` — themed tokens point at CSS vars (fallback = Light) on web; static
// Light on native. Constants are shared by every theme.
const themed = {};
TOKENS.forEach((k) => {
  themed[k] = isWeb ? `var(${cssVar(k)}, ${LIGHT[k]})` : LIGHT[k];
});
export const colors = { ...CONSTANT, ...themed };

export function applyTheme(id) {
  if (!isWeb) return;
  const palette = resolvePalette(id);
  const root = document.documentElement;
  TOKENS.forEach((k) => root.style.setProperty(cssVar(k), palette[k]));
  root.setAttribute('data-theme-mode', resolveMode(id));
  // Native form controls / scrollbars follow this.
  root.style.colorScheme = resolveMode(id);
  // Persist the resolved surfaces so the pre-bundle splash (see the injected
  // markup in the exported index.html) can paint the right theme with no flash.
  try {
    window.localStorage.setItem('appBg', palette.background);
    window.localStorage.setItem('appFg', palette.text);
  } catch {}
}

export function getThemeId() {
  if (!isWeb) return 'light';
  try {
    return window.localStorage.getItem(KEY) || 'system';
  } catch {
    return 'system';
  }
}

export function setThemeId(id) {
  if (isWeb) {
    try {
      window.localStorage.setItem(KEY, id);
    } catch {}
  }
  applyTheme(id);
  listeners.forEach((fn) => fn(id));
}

export function subscribeTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Apply the stored theme and keep 'system' in sync with the OS. Idempotent.
export function initTheme() {
  if (!isWeb) return;
  applyTheme(getThemeId());
  if (!mediaQuery && window.matchMedia) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getThemeId() === 'system') {
        applyTheme('system');
        listeners.forEach((fn) => fn('system'));
      }
    };
    if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', onChange);
    else if (mediaQuery.addListener) mediaQuery.addListener(onChange);
  }
}

// Apply as early as possible (module import, before first render) to avoid a
// flash of the Light fallback on a dark theme.
initTheme();

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
