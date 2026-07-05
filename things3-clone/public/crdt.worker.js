/* CRDT Web Worker — ygo (Yjs-in-Go) engine, IndexedDB persistence.
 *
 * Runs the Go-compiled WASM engine (crdt.wasm) off the main thread. The engine is
 * core/ydoc (our wrapper over reearth/ygo), exposed as __ydoc* globals. It
 * persists an opaque Yjs snapshot blob PER WORKSPACE in IndexedDB.
 *
 * Why IndexedDB (not OPFS/SQLite): the ygo snapshot is just a blob keyed by
 * workspace, and IndexedDB has no exclusive access-handle constraint — so it works
 * across tabs and survives reload races, unlike the OPFS SAHPool VFS (which threw
 * "createSyncAccessHandle ... another open Access Handle" when a second context
 * held the file). On first run we do a one-time, best-effort migration from the
 * old OPFS/SQLite store; any failure there is skipped so startup never blocks.
 *
 * The main thread (src/store/crdtClient.js) drives this over a tiny postMessage
 * RPC. See docs/crdt-ygo.md.
 */
/* eslint-disable no-undef */
importScripts('/wasm_exec.js');

let currentWs = 'local'; // active workspace id ('local' = signed-out/personal)
let ready = false;
const queue = [];

function unwrap(r) {
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'wasm call failed');
  return r;
}

// --- IndexedDB (one record per workspace: { clientid, snapshot }) ------------

const IDB_NAME = 'things3clone-ydoc';
const STORE = 'workspaces';
let _idb = null;

function openIDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    req.onsuccess = () => { _idb = req.result; resolve(_idb); };
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const d = await openIDB();
  return new Promise((resolve, reject) => {
    const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key, val) {
  const d = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDel(key) {
  const d = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Persist the active workspace's ygo document.
async function persist() {
  const clientid = unwrap(self.__ydocClientID()).result;
  const snapshot = unwrap(self.__ydocEncodeAll()).result;
  await idbPut(currentWs, { clientid, snapshot });
}

// Load the active workspace's engine from IndexedDB, or migrate/start fresh.
async function loadEngine() {
  const row = await idbGet(currentWs);
  if (row) {
    unwrap(self.__ydocLoad(row.clientid, row.snapshot || ''));
    return;
  }
  // Only 'local' can inherit anything from the old OPFS store.
  if (currentWs === 'local') {
    try { if (await migrateFromOpfs()) return; } catch (_) { /* ignore */ }
  }
  unwrap(self.__ydocNew(''));
  await persist();
}

// One-time, best-effort migration from the previous OPFS/SQLite store. Fully
// guarded and time-bounded: if OPFS can't be opened (e.g. the access-handle
// contention that motivated this change), we simply start fresh in IndexedDB.
let _sqliteTried = false;
async function migrateFromOpfs() {
  if (_sqliteTried) return false;
  _sqliteTried = true;
  try {
    importScripts('/sqlite3.js');
    if (typeof self.sqlite3InitModule !== 'function') return false;
    const sqlite3 = await self.sqlite3InitModule();
    let pool = null;
    for (let i = 0; i < 2; i++) {
      try { pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'things3clone' }); break; }
      catch (_) { await new Promise((r) => setTimeout(r, 150)); }
    }
    if (!pool) return false;

    let out = null;
    try {
      const db = new pool.OpfsSAHPoolDb('/things.db');
      const read = (sql) => {
        try { db.exec({ sql, rowMode: 'array', callback: (r) => { out = { clientid: r[0], snapshot: r[1] }; } }); } catch (_) { /* ignore */ }
      };
      read("SELECT clientid,snapshot FROM ydocws WHERE workspace='local'");
      if (!out) read('SELECT clientid,snapshot FROM ydoc WHERE id=1');
      try { db.close(); } catch (_) { /* ignore */ }
    } catch (_) { /* ignore */ }
    try { if (typeof pool.removeVfs === 'function') await pool.removeVfs(); } catch (_) { /* ignore */ }

    if (!out || !out.snapshot) return false;
    unwrap(self.__ydocLoad(out.clientid, out.snapshot));
    await persist();
    return true;
  } catch (_) {
    return false;
  }
}

// --- init: Go WASM -----------------------------------------------------------

async function init() {
  const goReady = new Promise((resolve) => { self.__onCrdtReady = resolve; });
  const go = new Go();
  const res = await WebAssembly.instantiateStreaming(fetch('/crdt.wasm'), go.importObject).catch(async () => {
    const buf = await (await fetch('/crdt.wasm')).arrayBuffer();
    return WebAssembly.instantiate(buf, go.importObject);
  });
  go.run(res.instance); // runs main(), which calls __onCrdtReady
  await goReady;

  await loadEngine();

  ready = true;
  const pending = queue.splice(0);
  for (const m of pending) enqueue(m);
  self.postMessage({ type: 'ready' });
}

// --- RPC (serialized so persistence stays ordered) ---------------------------

async function handle(msg) {
  const { id, method, args = [] } = msg;
  try {
    let result;
    switch (method) {
      case 'info':
        result = { clientID: unwrap(self.__ydocClientID()).result, hasData: unwrap(self.__ydocHasData()).result };
        break;
      case 'applyLocalSnapshot':
        unwrap(self.__ydocApplyLocalSnapshot(args[0]));
        await persist();
        result = true;
        break;
      case 'materialize':
        result = unwrap(self.__ydocMaterialize()).result;
        break;
      case 'stateVector':
        result = unwrap(self.__ydocStateVector()).result;
        break;
      case 'encodeDiff':
        result = unwrap(self.__ydocEncodeDiff(String(args[0] || ''))).result;
        break;
      case 'encodeAll':
        result = unwrap(self.__ydocEncodeAll()).result;
        break;
      case 'applyUpdate':
        unwrap(self.__ydocApplyUpdate(String(args[0] || '')));
        await persist();
        result = true;
        break;
      case 'hasData':
        result = unwrap(self.__ydocHasData()).result;
        break;
      case 'useWorkspace': {
        const ws = String(args[0] || 'local');
        if (ws !== currentWs) {
          currentWs = ws;
          await loadEngine();
        }
        result = { workspace: currentWs };
        break;
      }
      case 'reset':
        await idbDel(currentWs);
        unwrap(self.__ydocNew(''));
        await persist();
        result = true;
        break;
      default:
        throw new Error('unknown method: ' + method);
    }
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
}

// Serialize handlers so overlapping RPCs don't interleave their IndexedDB writes.
let _chain = Promise.resolve();
function enqueue(msg) {
  _chain = _chain.then(() => handle(msg)).catch(() => {});
}

self.onmessage = (ev) => {
  if (!ready) queue.push(ev.data);
  else enqueue(ev.data);
};

init().catch((e) => self.postMessage({ type: 'fatal', error: String((e && e.message) || e) }));
