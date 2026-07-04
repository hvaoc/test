/* CRDT Web Worker.
 *
 * Runs the Go-compiled WASM CRDT engine (crdt.wasm) off the main thread and
 * owns its IndexedDB persistence. The main thread (src/store/crdtClient.js)
 * drives it over a small postMessage RPC: {id, method, args} in, {id, ok,
 * result|error} out. Heavy work (diffing 2400+ tasks, merging tens of thousands
 * of ops, serialising several MB) never touches the UI thread.
 */
/* eslint-disable no-undef */
importScripts('/wasm_exec.js');

const DB_NAME = 'things3clone';
const STORE = 'kv';
const KEY = 'crdt:v1';

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
function idbGet(key) {
  return openIDB().then(
    (db) =>
      new Promise((res, rej) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      })
  );
}
function idbSet(key, value) {
  return openIDB().then(
    (db) =>
      new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      })
  );
}

// Unwrap the { ok, result|error, ... } object the WASM exports return.
function unwrap(r) {
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'wasm call failed');
  return r;
}

async function persist() {
  await idbSet(KEY, unwrap(self.__crdtSerialize()).result);
}

let ready = false;
const queue = [];

async function init() {
  // Restore the persisted replica, or start a fresh one.
  let loaded = false;
  try {
    const raw = await idbGet(KEY);
    if (raw) {
      const r = self.__crdtLoad(raw);
      loaded = r && r.ok;
    }
  } catch {
    /* corrupt → fresh */
  }
  if (!loaded) self.__crdtNew('');
  ready = true;
  const pending = queue.splice(0);
  for (const m of pending) handle(m);
  self.postMessage({ type: 'ready' });
}

async function handle(msg) {
  const { id, method, args = [] } = msg;
  try {
    let result;
    switch (method) {
      case 'info':
        result = { node: unwrap(self.__crdtNode()).result, hasData: unwrap(self.__crdtHasData()).result };
        break;
      case 'applyLocalSnapshot': {
        const r = unwrap(self.__crdtApplyLocalSnapshot(args[0]));
        await persist();
        result = { count: r.count };
        break;
      }
      case 'materialize':
        result = unwrap(self.__crdtMaterialize()).result; // state JSON string
        break;
      case 'peekPending':
        result = unwrap(self.__crdtPeekPending()).result; // ops JSON string
        break;
      case 'dropPending':
        unwrap(self.__crdtDropPending(args[0] | 0));
        await persist();
        result = true;
        break;
      case 'applyRemote': {
        const r = unwrap(self.__crdtApplyRemote(args[0]));
        result = { applied: r.applied, skipped: r.skipped };
        break;
      }
      case 'getCursor':
        result = unwrap(self.__crdtCursor()).result;
        break;
      case 'setCursor':
        unwrap(self.__crdtSetCursor(String(args[0] || '')));
        await persist();
        result = true;
        break;
      case 'hasData':
        result = unwrap(self.__crdtHasData()).result;
        break;
      default:
        throw new Error('unknown method: ' + method);
    }
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
}

self.onmessage = (ev) => {
  if (!ready) queue.push(ev.data);
  else handle(ev.data);
};

// The Go program calls this once its exported functions are registered.
self.__onCrdtReady = () => {
  init();
};

const go = new Go();
WebAssembly.instantiateStreaming(fetch('/crdt.wasm'), go.importObject)
  .catch(async () => {
    // Some environments can't stream-compile; fall back to arrayBuffer.
    const buf = await (await fetch('/crdt.wasm')).arrayBuffer();
    return WebAssembly.instantiate(buf, go.importObject);
  })
  .then((res) => go.run(res.instance))
  .catch((e) => self.postMessage({ type: 'fatal', error: String((e && e.message) || e) }));
