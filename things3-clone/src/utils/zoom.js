import { Platform } from 'react-native';

// Browser-style app zoom for the web / Wails desktop build. Backed by the WebKit
// `zoom` CSS on <html> (reflows like real browser zoom) and persisted in
// localStorage so it survives reloads/relaunches — independent of the task store
// (which re-seeds on every load in this build). No-op on native.

const KEY = 'appZoom';
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1;

const isWeb = Platform.OS === 'web' && typeof document !== 'undefined';
const clamp = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 100) / 100));

const listeners = new Set();

export function getZoom() {
  if (!isWeb) return ZOOM_DEFAULT;
  try {
    const v = parseFloat(window.localStorage.getItem(KEY));
    if (Number.isFinite(v)) return clamp(v);
  } catch {}
  return ZOOM_DEFAULT;
}

// Subscribe to zoom changes (e.g. so the Settings control reflects keyboard/menu
// zooming while it's open). Returns an unsubscribe fn.
export function subscribeZoom(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setZoom(value) {
  if (!isWeb) return ZOOM_DEFAULT;
  const z = clamp(value);
  document.documentElement.style.zoom = String(z);
  try {
    window.localStorage.setItem(KEY, String(z));
  } catch {}
  listeners.forEach((fn) => fn(z));
  return z;
}

// Relative step used by the keyboard shortcuts and the native View menu.
export function stepZoom(cmd) {
  if (cmd === 'in') return setZoom(getZoom() + ZOOM_STEP);
  if (cmd === 'out') return setZoom(getZoom() - ZOOM_STEP);
  return setZoom(ZOOM_DEFAULT); // 'reset'
}

// Re-apply the persisted level on launch.
export function applyStoredZoom() {
  if (isWeb) setZoom(getZoom());
}
