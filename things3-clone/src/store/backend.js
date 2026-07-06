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
import { recordStore, recordWorkerAvailable } from './recordClient';

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
export async function authenticate(url, username, password, workspace = '', email = '', mode = 'auto') {
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

  let res;
  if (mode === 'signup') {
    res = await jpost('/v1/register', { username, email, password });
    if (!res.ok) {
      if (res.status === 409) throw new Error('That username is already taken.');
      throw new Error(res.body.error || 'could not create account');
    }
  } else {
    res = await jpost('/v1/login', { username, password });
    if (!res.ok && res.status === 401 && mode === 'login') {
      throw new Error('Wrong username or password.');
    }
    if (!res.ok && res.status === 401 && mode === 'auto') {
      // Create the account on first use.
      const reg = await jpost('/v1/register', { username, email, password });
      if (!reg.ok) {
        if (reg.status === 409) throw new Error('Wrong password for that account.');
        throw new Error(reg.body.error || 'could not create account');
      }
      res = reg;
    }
    if (!res.ok) throw new Error(res.body.error || 'sign-in failed: ' + res.status);
  }

  const { token: session, userId, tenants = [], profile = {} } = res.body;
  // A workspace code puts everyone who enters it into one shared tenant (that's
  // how two accounts collaborate); otherwise use the personal workspace.
  let tenant;
  if (workspace && workspace.trim()) {
    const j = await jpost('/v1/join', { code: workspace.trim() }, session);
    if (!j.ok) throw new Error(j.body.error || 'could not join workspace');
    tenant = j.body.tenant;
  } else {
    if (!tenants.length) throw new Error('no tenant for this account');
    tenant = tenants[0];
  }

  const tok = await jpost('/v1/synctoken', { tenantId: tenant.id }, session);
  if (!tok.ok) throw new Error(tok.body.error || 'could not open tenant');

  configureServer({
    url: base, token: tok.body.token, session, userId,
    username: profile.username || username, // real username, not the email typed to log in
    email: profile.email || email, verified: !!profile.verified,
    tenantId: tenant.id, tenantName: tenant.name, role: tok.body.role,
  });
  await activateLocalReplica(tenant.id);
  return { userId, tenantId: tenant.id, role: tok.body.role, tenantName: tenant.name, verified: !!profile.verified };
}

// Update the cached verified/profile fields on the current server config (after a
// verification or profile change) without re-authenticating.
export function updateServerProfile(patch) {
  if (_server) {
    _server = { ..._server, ...patch };
    persistServer();
  }
}

// Point the local store at a workspace's own replica so switching workspaces
// never mixes their data. Web only (the worker keeps one DB per workspace);
// desktop/mobile use a single native store today.
export async function activateLocalReplica(tenantId) {
  try {
    if (backend().name === 'record') {
      await crdtClient.init();
      await crdtClient.useWorkspace(tenantId || 'local');
      // (The record engine uses a single OPFS DB today; per-workspace record
      // isolation is a follow-up. ygo notes/settings switch per workspace above.)
    }
  } catch {
    /* best effort */
  }
}

// Make an already-joined workspace the active one: mint a fresh sync token for it
// (using the session token) and switch the local replica. The caller then reloads
// app state from the switched replica.
export async function switchWorkspace(tenant) {
  if (!_server || !_server.session) throw new Error('not signed in');
  const base = _server.url.replace(/\/$/, '');
  const r = await fetch(base + '/v1/synctoken', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + _server.session },
    body: JSON.stringify({ tenantId: tenant.id }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'could not open workspace');
  configureServer({ ..._server, token: j.token, tenantId: tenant.id, tenantName: tenant.name, role: j.role });
  await activateLocalReplica(tenant.id);
  return { role: j.role };
}

export function logout() {
  configureServer(null);
  activateLocalReplica('local');
}

// This user's presence identity for the awareness channel: display name + a
// stable colour derived from their id. null when not signed in (solo/offline).
export function presenceIdentity() {
  if (!_server) return null;
  const name = _server.username || 'You';
  const key = String(_server.userId || name);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return { userId: key, user: name, color: `hsl(${h % 360} 65% 45%)` };
}

// Open the realtime WebSocket. It carries two things: data-change nudges
// (onNudge → pull) and awareness/presence (onPresence). Returns { close,
// sendPresence } — sendPresence(state) broadcasts this user's live presence
// (which task they're on, cursor position, name, colour) to teammates.
// Auto-reconnects with a short backoff and re-announces the last presence.
export function openRealtime({ onNudge, onPresence, onActivity } = {}) {
  if (typeof WebSocket === 'undefined' || !_server) {
    return { close: () => {}, sendPresence: () => {}, sendActivity: () => {} };
  }
  let ws = null;
  let closed = false;
  let timer = null;
  let lastPresence = null;

  const connect = () => {
    if (closed || !_server) return;
    const wsUrl = _server.url.replace(/^http/, 'ws') + '/v1/stream?token=' + encodeURIComponent(_server.token);
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    ws.onopen = () => {
      if (lastPresence) rawSend(lastPresence); // re-announce after a reconnect
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'changed') onNudge && onNudge();
      else if (msg.type === 'presence') onPresence && onPresence({ from: msg.from, state: msg.state });
      else if (msg.type === 'presence-leave') onPresence && onPresence({ from: msg.from, leave: true });
      else if (msg.type === 'activity') onActivity && onActivity({ from: msg.from, state: msg.state });
    };
    ws.onclose = () => {
      if (!closed) timer = setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
  };

  const rawSend = (state) => {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'presence', state }));
    } catch { /* ignore */ }
  };

  connect();
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) try { ws.close(); } catch { /* ignore */ }
    },
    sendPresence: (state) => {
      lastPresence = state;
      rawSend(state);
    },
    // Fire-and-forget ephemeral event (e.g. "added a task"); never stored.
    sendActivity: (state) => {
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'activity', state }));
      } catch { /* ignore */ }
    },
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

// Task notes whose scope should sync on demand (while their detail view is open).
const _openNotes = new Set();

// One offline-first state-vector exchange for a single scope (docs/architecture-1m
// §2.2). Pull first (send our sv, receive what we're missing + the server's sv),
// then push exactly what the server is missing. `scope` routes to the right room.
async function wasmSyncScope(base, headers, scope) {
  const sv = await crdtClient.stateVector(scope);
  const pr = await fetch(base + '/v1/pull', { method: 'POST', headers, body: JSON.stringify({ scope, sv }) });
  if (!pr.ok) throw new Error('pull failed: ' + pr.status);
  const pulled = await pr.json();
  let applied = 0;
  if (pulled.update) {
    await crdtClient.applyUpdate(scope, pulled.update);
    applied = 1;
  }
  const diff = await crdtClient.encodeDiff(scope, pulled.sv || '');
  const push = await fetch(base + '/v1/push', { method: 'POST', headers, body: JSON.stringify({ scope, update: diff }) });
  if (!push.ok) throw new Error('push failed: ' + push.status);
  const pushed = await push.json();
  return { applied, version: pushed.version };
}

// The record op-log sync for STRUCTURED data (tasks, projects, areas, …). Push local
// ops as deltas, pull the tenant's ops since our cursor. This replaces the monolithic
// shared ygo doc — O(change) on the wire, scales to 1M (docs/architecture-1m §3-4).
async function recordServerSync(base, headers) {
  const pending = await recordStore.pendingOps(0);
  if (pending.length) {
    const ops = pending.map((p) => p.op);
    const pr = await fetch(base + '/v1/records/push', { method: 'POST', headers, body: JSON.stringify({ ops }) });
    if (!pr.ok) throw new Error('records push failed: ' + pr.status);
    await recordStore.markSynced(pending.map((p) => p.seq));
  }
  const cur = await recordStore.cursor();
  const rr = await fetch(base + '/v1/records/pull', { method: 'POST', headers, body: JSON.stringify({ cursor: cur ? parseInt(cur, 10) : 0 }) });
  if (!rr.ok) throw new Error('records pull failed: ' + rr.status);
  const body = await rr.json();
  if (body.ops && body.ops.length) await recordStore.applyRemote(body.ops);
  await recordStore.setCursor(String(body.cursor != null ? body.cursor : ''));
  return (body.ops || []).length;
}

// Merge the record engine's structured state (source of truth for tasks/projects/…)
// with the ygo layer's settings (per-user) and any open task's notes (per-task doc).
async function coordinatorMaterialize() {
  const structured = JSON.parse(await recordStore.materialize());
  let settings = {};
  try {
    settings = JSON.parse(await crdtClient.materialize()).settings || {};
  } catch {
    /* ygo unavailable — structured still works */
  }
  structured.settings = settings;
  // Overlay notes for currently-open tasks (on-demand; the rest stay "").
  for (const id of _openNotes) {
    const t = structured.tasks.find((x) => x.id === id);
    if (t) {
      try { t.notes = await crdtClient.noteText(id); } catch { /* ignore */ }
    }
  }
  return structured;
}

// One-time migration: if the record engine is empty but the legacy shared ygo doc
// holds structured data, lift it into the record engine so tasks now sync via the
// op-log. Settings + notes already live on the ygo layer and stay there.
let _recordMigrated = false;
async function migrateYdocToRecordIfNeeded() {
  if (_recordMigrated) return;
  _recordMigrated = true;
  try {
    if (await recordStore.hasData()) return; // already on the record engine
    if (!(await crdtClient.hasData())) return; // nothing legacy to migrate
    const legacy = await crdtClient.materialize(); // old shared doc: entities + notes + settings
    await recordStore.applyLocalSnapshot(legacy);
  } catch {
    /* best-effort — a fresh start still works */
  }
}

async function coordinatorServerSync() {
  const base = _server.url.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + _server.token };
  // Structured data via the record op-log (tenant scope).
  const pulled = await recordServerSync(base, headers);
  // Settings (per-user) + any open task's notes via their ygo scopes. NO shared scope.
  await wasmSyncScope(base, headers, 'settings');
  for (const id of _openNotes) await wasmSyncScope(base, headers, 'note:' + id);
  return {
    adapter: 'server',
    pushed: 0,
    pulled,
    applied: pulled,
    skipped: 0,
    snapshot: JSON.stringify(await coordinatorMaterialize()),
  };
}

// The web coordinator: structured data on the record engine (op-log sync), settings
// + notes on the ygo layer. Replaces the single-ygo-doc adapter.
function coordinatorWebAdapter() {
  return {
    name: 'record',
    async loadSnapshot() {
      await recordStore.init();
      await crdtClient.init();
      await migrateYdocToRecordIfNeeded();
      const hasStructured = await recordStore.hasData();
      let settings = {};
      try { settings = JSON.parse(await crdtClient.materialize()).settings || {}; } catch { /* ignore */ }
      if (!hasStructured && Object.keys(settings).length === 0) return null;
      return await coordinatorMaterialize();
    },
    async saveSnapshot(state) {
      const json = JSON.stringify(serializableState(state));
      await recordStore.applyLocalSnapshot(json); // structured → record op-log
      await crdtClient.applyLocalSnapshotAux(json); // settings + notes → ygo
    },
    async sync() {
      await recordStore.init();
      await crdtClient.init();
      if (_server) return coordinatorServerSync();
      return { adapter: 'local' };
    },
  };
}

// Open a task's notes for on-demand sync (docs/architecture-1m §2.2): a task's
// notes are their own sync scope, synced only while its detail view is open. This
// registers the scope, syncs it once now, and returns the merged whole-state
// snapshot (or null) so the caller can refresh the note text. Works on every
// platform: Wails desktop + gomobile go through the Go store's SyncNote; web goes
// through the wasm worker.
export async function openTaskNote(taskId) {
  if (!taskId) return null;
  const app = wailsApp();
  const native = app ? null : nativeModule();
  try {
    if (app && typeof app.SyncNote === 'function') {
      const res = JSON.parse((await app.SyncNote(taskId)) || '{}');
      return res.snapshot ? JSON.parse(res.snapshot) : null;
    }
    if (native && typeof native.syncNote === 'function') {
      const snap = await native.syncNote(taskId);
      return snap ? JSON.parse(snap) : null;
    }
    if (backend().name === 'record') {
      _openNotes.add(taskId);
      await crdtClient.init();
      if (_server) {
        const base = _server.url.replace(/\/$/, '');
        const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + _server.token };
        await wasmSyncScope(base, headers, 'note:' + taskId);
      }
      // Merged structured state with this task's (now-synced) note overlaid.
      return await coordinatorMaterialize();
    }
  } catch {
    /* best-effort: offline or transient — the note still works locally */
  }
  return null;
}

// Stop syncing a task's notes (call when its detail view closes).
export function closeTaskNote(taskId) {
  if (!taskId) return;
  _openNotes.delete(taskId);
  try {
    const app = wailsApp();
    const native = app ? null : nativeModule();
    if (app && typeof app.CloseNote === 'function') app.CloseNote(taskId);
    else if (native && typeof native.closeNote === 'function') native.closeNote(taskId);
  } catch {
    /* ignore */
  }
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
  // Preferred: the record engine (op-log sync for structured data) + ygo (notes,
  // settings). Falls back to the pure-JS CRDT only when Workers/WASM are missing.
  if (recordWorkerAvailable() && crdtWorkerAvailable()) return coordinatorWebAdapter();
  return jsWebAdapter();
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
    } else if (recordWorkerAvailable() && crdtWorkerAvailable()) {
      await recordStore.init();
      await recordStore.reset();
      await recordStore.setCursor('');
      await crdtClient.init();
      await crdtClient.reset();
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
