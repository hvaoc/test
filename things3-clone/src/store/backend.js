// Offline-first persistence bridge. The app keeps its rich in-memory model and
// hands this module whole-state snapshots; the module routes them to the best
// available durable store for the current platform:
//
//   • Wails desktop  → the embedded Go SQLite CRDT engine (window.go.main.App)
//   • iOS / Android  → the same Go engine via a gomobile native module
//                       (NativeModules.Playdata)
//   • Web / anything → the Go CRDT engine compiled to WASM, run in a Web Worker
//                       (store/crdtClient.js + public/crdt.worker.js) that
//                       persists to real SQLite (sqlite.org's WASM build on the
//                       OPFS SAHPool VFS). Falls back to the pure-JS CRDT +
//                       IndexedDB (store/crdt.js) if WASM/Workers are missing.
//
// All platforms run the SAME field-level CRDT — Go on desktop/mobile, that same
// Go engine compiled to WASM in the browser — over SQLite storage, and speak the
// same op wire format, so every platform is a first-class replica that converges
// through the sync server. They share one async interface: loadSnapshot(),
// saveSnapshot(state), sync().

import { Platform } from 'react-native';
import { Crdt } from './crdt';
import { crdtClient, crdtWorkerAvailable } from './crdtClient';

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
  // On mobile the Go store must be opened (with the app's files dir, chosen
  // natively) before use. Wails opens it in the Go startup hook, so no-op there.
  let opened = null;
  const ensureOpen = () => {
    if (!native || typeof impl.open !== 'function') return Promise.resolve();
    if (!opened) opened = impl.open().catch(() => {});
    return opened;
  };
  return {
    name: app ? 'wails' : 'native',
    async loadSnapshot() {
      await ensureOpen();
      const json = await impl.LoadSnapshot?.() ?? await impl.loadSnapshot?.();
      if (!json) return null;
      try {
        return JSON.parse(json);
      } catch {
        return null;
      }
    },
    async saveSnapshot(state) {
      await ensureOpen();
      const json = JSON.stringify(serializableState(state));
      await (impl.SaveSnapshot?.(json) ?? impl.saveSnapshot?.(json));
    },
    async sync() {
      await ensureOpen();
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

const CRDT_KEY = 'crdt:v1';

// Persist/restore the raw serialized CRDT (a JSON string) through IndexedDB or,
// failing that, localStorage.
async function readRaw(key) {
  try {
    if (idbAvailable()) {
      const db = await openIDB();
      return (await idbGet(db, key)) || null;
    }
    if (typeof localStorage !== 'undefined') return localStorage.getItem(key);
  } catch {
    /* unavailable */
  }
  return null;
}
async function writeRaw(key, value) {
  try {
    if (idbAvailable()) {
      const db = await openIDB();
      await idbSet(db, key, value);
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {
    /* quota / private mode — stay in memory */
  }
}

// The browser replica: a single in-memory CRDT rehydrated from storage. Its
// node id (device identity) persists inside the serialized blob, so the same
// browser keeps a stable identity across reloads — required for HLC tie-breaks.
let _crdt = null;
async function loadCrdt() {
  if (_crdt) return _crdt;
  const raw = await readRaw(CRDT_KEY);
  if (raw) {
    try {
      _crdt = Crdt.fromJSON(JSON.parse(raw));
      return _crdt;
    } catch {
      /* corrupt → fresh replica */
    }
  }
  _crdt = new Crdt();
  return _crdt;
}
async function persistCrdt() {
  if (_crdt) await writeRaw(CRDT_KEY, JSON.stringify(_crdt.toJSON()));
}

// Server config for web sync (set by the Settings sign-in). Until configured,
// web is offline-only but still a full CRDT replica — it just has no peer.
const SERVER_KEY = 'sync:server:v1';
let _server = null; // { url, token, userId, username }

function persistServer() {
  try {
    if (typeof localStorage === 'undefined') return;
    if (_server) localStorage.setItem(SERVER_KEY, JSON.stringify(_server));
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    /* ignore */
  }
}
function loadServerConfig() {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(SERVER_KEY);
    if (raw) _server = JSON.parse(raw);
  } catch {
    /* ignore */
  }
}
loadServerConfig(); // restore a prior session at module load

export function configureServer(cfg) {
  _server = cfg && cfg.url && cfg.token ? cfg : null;
  persistServer();
  // On the desktop (Wails), the Go engine does the actual push/pull, so hand it
  // the same connection. The JS side keeps its own _server for the realtime
  // WebSocket + Settings UI. Fire-and-forget.
  try {
    const app = wailsApp();
    if (app && typeof app.SetSyncServer === 'function') {
      if (_server) app.SetSyncServer(_server.url, _server.token);
      else if (typeof app.ClearSyncServer === 'function') app.ClearSyncServer();
    }
  } catch {
    /* ignore — sync still works once the app rebinds */
  }
}
export function serverConfig() {
  return _server;
}

// Connect to the sync server (Phase 2: real accounts). Signs in — creating the
// account on first use for a single-button UX — then opens the user's active
// tenant and mints a tenant-scoped SYNC token. That sync token is what every
// push/pull uses, so the tenant is baked in and the rest of the client
// (including the desktop/mobile bridge) needs no new fields. Teams: additional
// members are added server-side (POST /v1/members); switching the active tenant
// is future UI. `mode` is accepted for forward-compatibility.
export async function authenticate(url, username, password, mode = 'login') {
  const base = url.replace(/\/$/, '');
  const jpost = async (path, body, token) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: j };
  };

  let res = await jpost('/v1/login', { username, password });
  if (!res.ok && res.status === 401) res = await jpost('/v1/register', { username, password });
  if (!res.ok) throw new Error(res.body.error || 'sign-in failed: ' + res.status);

  const { token: session, userId, tenants = [] } = res.body;
  if (!tenants.length) throw new Error('no tenant for this account');
  const tenant = tenants[0]; // active tenant defaults to the personal one

  const tok = await jpost('/v1/synctoken', { tenantId: tenant.id }, session);
  if (!tok.ok) throw new Error(tok.body.error || 'could not open tenant');

  configureServer({
    url: base, token: tok.body.token, session, userId, username,
    tenantId: tenant.id, tenantName: tenant.name, role: tok.body.role,
  });
  return { userId, tenantId: tenant.id, role: tok.body.role };
}

export function logout() {
  configureServer(null);
}

// Open a realtime WebSocket that fires onNudge() whenever this user's data
// changes on another device, so the caller can pull immediately. Returns a
// close function. Auto-reconnects with a short backoff.
export function openRealtime(onNudge) {
  if (typeof WebSocket === 'undefined' || !_server) return () => {};
  let ws = null;
  let closed = false;
  let timer = null;
  const connect = () => {
    if (closed || !_server) return;
    const wsUrl = _server.url.replace(/^http/, 'ws') + '/v1/stream?token=' + encodeURIComponent(_server.token);
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    ws.onmessage = () => onNudge && onNudge();
    ws.onclose = () => {
      if (!closed) timer = setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  };
  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (ws) try { ws.close(); } catch { /* ignore */ }
  };
}

const PUSH_CHUNK = 4000; // cap request size (first sync can be tens of thousands of ops)

async function serverSync(crdt) {
  const base = _server.url.replace(/\/$/, '');
  const pending = crdt.takePending();
  // Push local ops in chunks so the first (full-history) sync doesn't send one
  // multi-megabyte request. On failure, requeue the not-yet-sent remainder.
  for (let i = 0; i < pending.length; i += PUSH_CHUNK) {
    const chunk = pending.slice(i, i + PUSH_CHUNK);
    const r = await fetch(base + '/v1/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + _server.token },
      body: JSON.stringify({ ops: chunk }),
    }).catch((e) => {
      throw e;
    });
    if (!r.ok) {
      crdt.pending.unshift(...pending.slice(i)); // requeue remainder
      throw new Error('push failed: ' + r.status);
    }
  }
  // Pull remote ops since our cursor.
  const pr = await fetch(
    _server.url.replace(/\/$/, '') + '/v1/pull?cursor=' + encodeURIComponent(crdt.cursor || ''),
    { headers: { authorization: 'Bearer ' + _server.token } }
  );
  if (!pr.ok) throw new Error('pull failed: ' + pr.status);
  const body = await pr.json();
  const { applied, skipped } = crdt.applyRemote(body.ops || []);
  crdt.cursor = body.cursor || crdt.cursor;
  await persistCrdt();
  return {
    adapter: 'server',
    pushed: pending.length,
    pulled: (body.ops || []).length,
    applied,
    skipped,
    cursor: crdt.cursor,
    snapshot: JSON.stringify(crdt.materialize()),
  };
}

// --- WASM-worker adapter: the Go engine compiled to WASM, in a Web Worker ---

async function wasmServerSync() {
  const base = _server.url.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + _server.token };

  // Offline-first state-vector exchange (docs/crdt-ygo.md §4). Pull first: send
  // our state vector, receive exactly what we're missing plus the server's own
  // state vector. Then push exactly what the server is missing.
  const sv = await crdtClient.stateVector();
  const pr = await fetch(base + '/v1/pull', { method: 'POST', headers, body: JSON.stringify({ sv }) });
  if (!pr.ok) throw new Error('pull failed: ' + pr.status);
  const pulled = await pr.json();
  let applied = 0;
  if (pulled.update) {
    await crdtClient.applyUpdate(pulled.update);
    applied = 1;
  }

  const diff = await crdtClient.encodeDiff(pulled.sv || '');
  const push = await fetch(base + '/v1/push', { method: 'POST', headers, body: JSON.stringify({ update: diff }) });
  if (!push.ok) throw new Error('push failed: ' + push.status);
  const pushed = await push.json();

  return {
    adapter: 'server',
    pushed: pushed.version,
    pulled: applied,
    applied,
    skipped: 0,
    snapshot: await crdtClient.materialize(),
  };
}

function wasmWebAdapter() {
  return {
    name: 'wasm',
    async loadSnapshot() {
      await crdtClient.init();
      if (!(await crdtClient.hasData())) return null;
      return JSON.parse(await crdtClient.materialize());
    },
    async saveSnapshot(state) {
      await crdtClient.applyLocalSnapshot(JSON.stringify(serializableState(state)));
    },
    async sync() {
      await crdtClient.init();
      if (_server) return wasmServerSync();
      return { adapter: 'local' };
    },
  };
}

// --- pure-JS adapter (fallback when WASM/Workers are unavailable) ---

function jsWebAdapter() {
  return {
    name: idbAvailable() ? 'indexeddb' : 'localstorage',
    async loadSnapshot() {
      const c = await loadCrdt();
      return c.hasData() ? c.materialize() : null;
    },
    async saveSnapshot(state) {
      const c = await loadCrdt();
      c.applyLocalSnapshot(serializableState(state));
      await persistCrdt();
    },
    async sync() {
      const c = await loadCrdt();
      if (_server) return serverSync(c);
      return { adapter: 'local' };
    },
  };
}

function webAdapter() {
  return crdtWorkerAvailable() ? wasmWebAdapter() : jsWebAdapter();
}

// ---------------------------------------------------------------------------
// Public singleton.
// ---------------------------------------------------------------------------

let _backend = null;
export function backend() {
  if (!_backend) _backend = goAdapter() || webAdapter();
  return _backend;
}

// Wipe ALL local data on this device and sign out, so the app truly starts
// fresh. Handles every platform: Go engine (desktop/mobile), WASM worker + OPFS
// SQLite (web), and the pure-JS + IndexedDB fallback. This is what a user needs
// instead of DevTools "Clear site data", which doesn't touch OPFS.
export async function resetLocal() {
  logout(); // disconnect from the server so we don't immediately re-pull its data
  const app = wailsApp();
  const native = app ? null : nativeModule();
  try {
    if (app && typeof app.ResetStore === 'function') {
      await app.ResetStore();
    } else if (native && typeof native.reset === 'function') {
      await native.reset();
    } else if (crdtWorkerAvailable()) {
      await crdtClient.init();
      await crdtClient.reset();
    } else {
      // pure-JS fallback: drop the IndexedDB blob and reset the in-memory replica
      _crdt = new Crdt();
      await persistCrdt();
    }
  } catch {
    /* best-effort */
  }
}

export const loadSnapshot = () => backend().loadSnapshot();
export const saveSnapshot = (state) => backend().saveSnapshot(state);
export const sync = () => backend().sync();
export const backendName = () => backend().name;
