// Main-thread client for the CRDT Web Worker (public/crdt.worker.js), which runs
// the Go-compiled WASM engine. Communication is a tiny promise-based RPC over
// postMessage. The worker owns the engine + its IndexedDB persistence; this
// client just forwards calls and resolves their results, so the UI thread never
// blocks on CRDT work.

export function crdtWorkerAvailable() {
  return (
    typeof Worker !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    typeof indexedDB !== 'undefined'
  );
}

let _worker = null;
let _ready = null;
let _seq = 0;
const _pending = new Map();

function ensureWorker() {
  if (_ready) return _ready;
  _ready = new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker('/crdt.worker.js');
    } catch (e) {
      reject(e);
      return;
    }
    _worker = worker;
    worker.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.type === 'ready') return resolve();
      if (d.type === 'fatal') return reject(new Error(d.error || 'worker fatal'));
      const p = _pending.get(d.id);
      if (!p) return;
      _pending.delete(d.id);
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || 'rpc error'));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
  });
  // If the worker failed to start (e.g. a transient OPFS handle race), forget it
  // so the next call spins up a fresh one instead of caching the failure forever.
  _ready.catch(() => {
    _ready = null;
    if (_worker) { try { _worker.terminate(); } catch (_) { /* ignore */ } }
    _worker = null;
  });
  return _ready;
}

async function call(method, args = []) {
  await ensureWorker();
  const id = ++_seq;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    _worker.postMessage({ id, method, args });
  });
}

// The engine speaks whole-state snapshots + opaque Yjs updates (base64) and
// offline-first state-vector sync. Sync/persistence are PER-SCOPE ("shared",
// "settings", "note:<taskId>") — see docs/architecture-1m.md §2.2 — so the sync
// primitives take a scope; the whole-state seam (applyLocalSnapshot/materialize)
// routes across scopes internally.
export const crdtClient = {
  init: () => ensureWorker().then(() => call('info')),
  info: () => call('info'),
  applyLocalSnapshot: (stateJSON) => call('applyLocalSnapshot', [stateJSON]),
  // Apply only the ygo-layer parts (settings + notes); structured entities are owned
  // by the record engine now.
  applyLocalSnapshotAux: (stateJSON) => call('applyLocalSnapshotAux', [stateJSON]),
  materialize: () => call('materialize'),
  noteText: (taskId) => call('noteText', [taskId]), // a task's note text (per-task doc)
  scopes: () => call('scopes'), // string[] of live scopes to sync
  stateVector: (scope) => call('stateVector', [scope]), // base64 state vector for a scope
  encodeDiff: (scope, sinceSVb64) => call('encodeDiff', [scope, sinceSVb64]), // base64 update peer is missing
  encodeAll: (scope) => call('encodeAll', [scope]), // base64 full-state update for a scope
  applyUpdate: (scope, updateB64) => call('applyUpdate', [scope, updateB64]),
  hasData: () => call('hasData'),
  reset: () => call('reset'),
  // Switch the active workspace's local replica (each workspace has its own DB).
  useWorkspace: (ws) => call('useWorkspace', [ws]),
};
