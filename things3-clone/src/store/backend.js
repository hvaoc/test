// Offline-first persistence bridge. The app keeps its rich in-memory model and
// hands this module whole-state snapshots; the module routes them to the best
// available durable store for the current platform:
//
//   • Wails desktop  → the embedded Go SQLite engine (window.go.main.App)
//   • iOS / Android  → the same Go engine via a gomobile native module
//                       (NativeModules.Playdata)
//   • Web / anything → IndexedDB (with a localStorage fallback)
//
// All three share one async interface: loadSnapshot(), saveSnapshot(state),
// sync(). The Go-backed platforms also do real cloud sync; the web fallback
// is local-only (sync() is a no-op there) but still fully offline-first.

import { Platform } from 'react-native';

// Only the persisted slices of state travel to storage (never `loaded`, etc.).
export function serializableState(state) {
  return {
    version: state.version,
    areas: state.areas,
    projects: state.projects,
    headings: state.headings,
    tasks: state.tasks,
    tags: state.tags,
    customViews: state.customViews,
    settings: state.settings,
  };
}

// ---------------------------------------------------------------------------
// Backend selection.
// ---------------------------------------------------------------------------

function wailsApp() {
  if (typeof window === 'undefined') return null;
  const app = window.go && window.go.main && window.go.main.App;
  return app && typeof app.LoadSnapshot === 'function' ? app : null;
}

function nativeModule() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    // Lazy require so web/desktop bundles don't choke on the native module.
    const { NativeModules } = require('react-native');
    const m = NativeModules.Playdata;
    return m && typeof m.loadSnapshot === 'function' ? m : null;
  } catch {
    return null;
  }
}

// --- Go-backed adapter (Wails desktop OR gomobile native module) ------------

function goAdapter() {
  const app = wailsApp();
  const native = app ? null : nativeModule();
  const impl = app || native;
  if (!impl) return null;
  return {
    name: app ? 'wails' : 'native',
    async loadSnapshot() {
      const json = await impl.LoadSnapshot?.() ?? await impl.loadSnapshot?.();
      if (!json) return null;
      try {
        return JSON.parse(json);
      } catch {
        return null;
      }
    },
    async saveSnapshot(state) {
      const json = JSON.stringify(serializableState(state));
      await (impl.SaveSnapshot?.(json) ?? impl.saveSnapshot?.(json));
    },
    async sync() {
      const raw = await (impl.Sync?.() ?? impl.sync?.());
      try {
        return JSON.parse(raw);
      } catch {
        return { adapter: 'unknown' };
      }
    },
  };
}

// --- IndexedDB adapter (web fallback) ---------------------------------------

const DB_NAME = 'things3clone';
const STORE = 'kv';
const KEY = 'state:v2';

function idbAvailable() {
  return typeof indexedDB !== 'undefined';
}

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function webAdapter() {
  return {
    name: idbAvailable() ? 'indexeddb' : 'localstorage',
    async loadSnapshot() {
      try {
        if (idbAvailable()) {
          const db = await openIDB();
          const v = await idbGet(db, KEY);
          return v ? JSON.parse(v) : null;
        }
        if (typeof localStorage !== 'undefined') {
          const v = localStorage.getItem(KEY);
          return v ? JSON.parse(v) : null;
        }
      } catch {
        /* corrupt or unavailable → seed */
      }
      return null;
    },
    async saveSnapshot(state) {
      const json = JSON.stringify(serializableState(state));
      try {
        if (idbAvailable()) {
          const db = await openIDB();
          await idbSet(db, KEY, json);
        } else if (typeof localStorage !== 'undefined') {
          localStorage.setItem(KEY, json);
        }
      } catch {
        /* quota / private mode — stay in memory */
      }
    },
    // Web is local-only; a real cloud adapter lives in the Go engine.
    async sync() {
      return { adapter: 'local' };
    },
  };
}

// ---------------------------------------------------------------------------
// Public singleton.
// ---------------------------------------------------------------------------

let _backend = null;
export function backend() {
  if (!_backend) _backend = goAdapter() || webAdapter();
  return _backend;
}

export const loadSnapshot = () => backend().loadSnapshot();
export const saveSnapshot = (state) => backend().saveSnapshot(state);
export const sync = () => backend().sync();
export const backendName = () => backend().name;
