// Main-thread client for the web record adapter Worker (public/record.worker.js) —
// the RecordStore port for the web tier (docs/architecture-1m.md §5.1). It runs the
// official sqlite.wasm + OPFS engine off the UI thread.
//
// MULTI-TAB: OPFS SQLite is single-owner (one context may hold the DB). So exactly
// ONE tab is elected LEADER (via the Web Locks API) and runs the dedicated worker;
// every other tab is a FOLLOWER that proxies its reads/writes to the leader over a
// BroadcastChannel and awaits the reply. After any write, the leader broadcasts a
// "changed" ping so all tabs refresh. BroadcastChannel is local — this works fully
// OFFLINE, no server. When the leader tab closes, its lock frees and another tab is
// elected and re-opens the DB. (A SharedWorker/ServiceWorker can't own OPFS reliably:
// SAHPool needs a dedicated worker with a stable lifetime.)

const RPC_CHANNEL = 'things3-record-rpc';
const LEADER_LOCK = 'things3-record-leader';
const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

export function recordWorkerAvailable() {
  return (
    typeof Worker !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    typeof indexedDB !== 'undefined'
  );
}

const multiTab = typeof BroadcastChannel !== 'undefined' && !!(typeof navigator !== 'undefined' && navigator.locks);

// --- cross-tab change subscription (REMOTE changes from other tabs) ---------
const _changeCbs = new Set();
export function onRecordChanged(cb) {
  _changeCbs.add(cb);
  return () => _changeCbs.delete(cb);
}
function fireChange() {
  for (const cb of _changeCbs) { try { cb(); } catch (_) { /* ignore */ } }
}

// --- local-write subscription (THIS tab changed the store) ------------------
// Distinct from onRecordChanged: fired after a data-changing write made on this
// tab, so query-backed views (useRecordList) re-run. TasksContext uses the remote
// signal above (to avoid reloading on its own writes); the query mirror uses both.
const _writeCbs = new Set();
export function onRecordWrite(cb) {
  _writeCbs.add(cb);
  return () => _writeCbs.delete(cb);
}
function fireWrite() {
  for (const cb of _writeCbs) { try { cb(); } catch (_) { /* ignore */ } }
}

// Which methods can change data → notify other tabs. applyLocalSnapshot/applyRemote
// return an op count (0 = no change) so a no-op save never notifies (no reload loop).
const ALWAYS_WRITE = new Set(['createTask', 'setTaskField', 'toggleComplete', 'moveTask', 'deleteTask', 'hydrate', 'reset']);
const COUNTED_WRITE = new Set(['applyLocalSnapshot', 'applyRemote']);
function didChange(method, result) {
  return ALWAYS_WRITE.has(method) || (COUNTED_WRITE.has(method) && !!result);
}

// --- the dedicated worker (only the LEADER runs it) ------------------------
let _worker = null;
let _workerReady = null;
let _wseq = 0;
const _wpending = new Map();

function ensureLeaderWorker() {
  if (_workerReady) return _workerReady;
  _workerReady = new Promise((resolve, reject) => {
    let w;
    try { w = new Worker('/record.worker.js'); } catch (e) { reject(e); return; }
    _worker = w;
    w.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.type === 'ready') return resolve();
      if (d.type === 'fatal') return reject(new Error(d.error || 'record worker fatal'));
      const p = _wpending.get(d.id);
      if (!p) return;
      _wpending.delete(d.id);
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || 'rpc error'));
    };
    w.onerror = (e) => reject(new Error(e.message || 'record worker error'));
  });
  _workerReady.catch(() => { _workerReady = null; if (_worker) { try { _worker.terminate(); } catch (_) { /* ignore */ } } _worker = null; });
  return _workerReady;
}
function workerCall(method, args = []) {
  return ensureLeaderWorker().then(() => new Promise((resolve, reject) => {
    const id = ++_wseq;
    _wpending.set(id, { resolve, reject });
    _worker.postMessage({ id, method, args });
  }));
}

// --- role election ---------------------------------------------------------
let _role = null; // 'leader' | 'follower'
let _roleReady = null;
let _bc = null;
const _followerPending = new Map(); // id -> {resolve, reject, timer}
const _leaderSeen = new Map();      // dedupe retried follower writes: reqId -> result

function initCoordinator() {
  if (_roleReady) return _roleReady;

  // Single-tab fallback: no BroadcastChannel/Web Locks → always leader, no proxying.
  if (!multiTab) {
    _role = 'leader';
    _roleReady = ensureLeaderWorker();
    return _roleReady;
  }

  _bc = new BroadcastChannel(RPC_CHANNEL);
  _bc.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'changed') { fireChange(); return; }

    // LEADER: serve a follower's RPC on the worker and reply (deduping retries).
    if (m.type === 'req' && _role === 'leader') {
      if (_leaderSeen.has(m.id)) { _bc.postMessage({ type: 'res', to: m.from, id: m.id, ok: true, result: _leaderSeen.get(m.id) }); return; }
      workerCall(m.method, m.args).then(
        (result) => {
          _leaderSeen.set(m.id, result);
          if (_leaderSeen.size > 500) _leaderSeen.clear();
          _bc.postMessage({ type: 'res', to: m.from, id: m.id, ok: true, result });
          if (didChange(m.method, result)) {
            _bc.postMessage({ type: 'changed' }); // other tabs
            fireChange();                          // the leader's OWN tab (no self-echo on the channel)
          }
        },
        (e) => _bc.postMessage({ type: 'res', to: m.from, id: m.id, ok: false, error: String((e && e.message) || e) })
      );
      return;
    }

    // FOLLOWER: match a reply to our outgoing request.
    if (m.type === 'res' && m.to === TAB_ID) {
      const p = _followerPending.get(m.id);
      if (p) { clearTimeout(p.timer); _followerPending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || 'rpc error')); }
      return;
    }

    // A new leader announced itself → re-send any in-flight follower requests now.
    if (m.type === 'leader-up' && _role === 'follower') {
      for (const [, p] of _followerPending) p.send();
      return;
    }
  };

  _roleReady = new Promise((resolve) => {
    _role = 'follower'; // until we win the lock
    // Blocking lock request: the callback fires when WE hold leadership (first tab:
    // immediately; others: when the current leader's tab closes). Held forever.
    navigator.locks.request(LEADER_LOCK, () => new Promise(() => {
      _role = 'leader';
      ensureLeaderWorker().then(() => { try { _bc.postMessage({ type: 'leader-up' }); } catch (_) { /* ignore */ } resolve(); });
      // never resolves → keep leadership until this tab is closed
    }));
    // If we didn't get leadership promptly, proceed as a follower.
    setTimeout(() => { if (_role !== 'leader') resolve(); }, 200);
  });
  return _roleReady;
}

// Follower RPC over the channel, with resend until the leader replies (handles the
// leader's worker still booting). Reads + applyLocalSnapshot are idempotent, and the
// leader dedupes by request id, so a resend never double-applies.
function followerCall(method, args) {
  return new Promise((resolve, reject) => {
    const id = TAB_ID + ':' + (++_wseq);
    let attempts = 0;
    const entry = { resolve, reject, timer: null, send: null };
    const send = () => {
      attempts += 1;
      if (attempts > 40) { _followerPending.delete(id); reject(new Error('record: no leader responded')); return; }
      try { _bc.postMessage({ type: 'req', from: TAB_ID, id, method, args }); } catch (e) { reject(e); return; }
      entry.timer = setTimeout(send, 250);
    };
    entry.send = send;
    _followerPending.set(id, entry);
    send();
  });
}

async function call(method, args = []) {
  await initCoordinator();
  if (_role === 'leader') {
    const result = await workerCall(method, args);
    if (didChange(method, result)) {
      if (multiTab) { try { _bc.postMessage({ type: 'changed' }); } catch (_) { /* ignore */ } } // other tabs
      fireWrite(); // this tab's query-backed views (useRecordList)
    }
    return result;
  }
  const result = await followerCall(method, args);
  // A follower's write is applied+broadcast by the leader; fire the local write
  // signal here too so this tab's own query views refresh immediately.
  if (didChange(method, result)) fireWrite();
  return result;
}

// The RecordStore port. Mirrors desktop/core/record's public API.
export const recordStore = {
  init: () => initCoordinator(),
  hydrate: (tasks) => call('hydrate', [tasks]),
  hasData: () => call('hasData'),
  queryTasks: (q) => call('queryTasks', [q]),
  queryList: (listId, params) => call('queryList', [listId, params]),
  searchTasks: (text, q) => call('searchTasks', [text, q]),
  countTasks: (q) => call('countTasks', [q]),
  getTask: (id) => call('getTask', [id]),
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
