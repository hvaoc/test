// Main-thread client for the web record adapter Worker (public/record.worker.js) —
// the RecordStore port for the web tier (docs/architecture-1m.md §5.1). It runs the
// official sqlite.wasm + OPFS engine off the UI thread and speaks the same
// query/write API as the native Go core/record store, over a tiny promise-based RPC.
//
// The app codes against this interface, never against SQLite: paged queries in,
// per-entity writes in, rows out. Only used on web; native (Wails/gomobile) binds
// the Go engine directly.

export function recordWorkerAvailable() {
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
      worker = new Worker('/record.worker.js');
    } catch (e) {
      reject(e);
      return;
    }
    _worker = worker;
    worker.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.type === 'ready') return resolve();
      if (d.type === 'fatal') return reject(new Error(d.error || 'record worker fatal'));
      const p = _pending.get(d.id);
      if (!p) return;
      _pending.delete(d.id);
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || 'rpc error'));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'record worker error'));
  });
  // Don't cache a failed init: forget it so the next call spins up a fresh worker.
  _ready.catch(() => {
    _ready = null;
    if (_worker) {
      try { _worker.terminate(); } catch (_) { /* ignore */ }
    }
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

// The RecordStore port. Mirrors desktop/core/record's public API.
export const recordStore = {
  init: () => ensureWorker(),
  // One-time bulk import from the app's current in-memory state.
  hydrate: (tasks) => call('hydrate', [tasks]),
  hasData: () => call('hasData'),
  // Reads (paged, indexed) — return list-view rows, not the whole workspace.
  queryTasks: (q) => call('queryTasks', [q]),
  queryList: (listId, params) => call('queryList', [listId, params]),
  searchTasks: (text, q) => call('searchTasks', [text, q]),
  countTasks: (q) => call('countTasks', [q]),
  getTask: (id) => call('getTask', [id]),
  // Per-entity writes (O(1)).
  createTask: (t) => call('createTask', [t]),
  setTaskField: (id, field, value) => call('setTaskField', [id, field, value]),
  toggleComplete: (id, completed) => call('toggleComplete', [id, completed]),
  moveTask: (id, beforeId, afterId) => call('moveTask', [id, beforeId, afterId]),
  deleteTask: (id) => call('deleteTask', [id]),
  reset: () => call('reset'),
  // Whole-state seam + op-log sync (structured data — replaces the shared ygo doc).
  applyLocalSnapshot: (state) => call('applyLocalSnapshot', [state]),
  materialize: () => call('materialize'),
  pendingOps: (limit) => call('pendingOps', [limit]),
  markSynced: (seqs) => call('markSynced', [seqs]),
  applyRemote: (ops) => call('applyRemote', [ops]),
  cursor: () => call('cursor'),
  setCursor: (c) => call('setCursor', [c]),
};
