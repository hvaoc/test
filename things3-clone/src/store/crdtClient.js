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

export const crdtClient = {
  init: () => ensureWorker().then(() => call('info')),
  info: () => call('info'),
  applyLocalSnapshot: (stateJSON) => call('applyLocalSnapshot', [stateJSON]),
  materialize: () => call('materialize'),
  peekPending: () => call('peekPending'),
  dropPending: (n) => call('dropPending', [n]),
  applyRemote: (opsJSON) => call('applyRemote', [opsJSON]),
  getCursor: () => call('getCursor'),
  setCursor: (c) => call('setCursor', [c]),
  hasData: () => call('hasData'),
  reset: () => call('reset'),
};
