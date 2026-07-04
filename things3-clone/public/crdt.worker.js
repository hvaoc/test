/* CRDT Web Worker.
 *
 * Runs the Go-compiled WASM CRDT engine (crdt.wasm) off the main thread and
 * persists its registers in real SQLite via sqlite.org's WASM build
 * (sqlite3.wasm) on the OPFS SAHPool VFS — the same storage model as the
 * desktop/mobile SQLite store, now in the browser. The engine reports the exact
 * register rows each mutation changed, so we upsert only the delta instead of
 * rewriting everything.
 *
 * Two WASM modules load in this one classic worker: Go's (the CRDT logic) and
 * SQLite's (durable storage). The main thread (src/store/crdtClient.js) drives
 * it over a tiny postMessage RPC.
 */
/* eslint-disable no-undef */
importScripts('/wasm_exec.js', '/sqlite3.js');

const US = '\x1f';
const ek = (kind, id) => kind + US + id;

let db = null; // sqlite oo1 DB (OPFS-backed)
let ready = false;
const queue = [];

// Unwrap the { ok, result|error } object the Go WASM exports return.
function unwrap(r) {
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'wasm call failed');
  return r;
}

// --- SQLite helpers ---------------------------------------------------------

function exec(sql, bind) {
  db.exec(bind ? { sql, bind } : sql);
}
function txn(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}
function upsertMany(sql, rows, toArgs) {
  if (!rows || !rows.length) return;
  const stmt = db.prepare(sql);
  try {
    for (const r of rows) {
      stmt.bind(toArgs(r));
      stmt.step();
      stmt.reset();
    }
  } finally {
    stmt.finalize();
  }
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fields(kind TEXT,id TEXT,field TEXT,value TEXT,hlc TEXT,PRIMARY KEY(kind,id,field));
    CREATE TABLE IF NOT EXISTS setelems(kind TEXT,id TEXT,field TEXT,elem TEXT,present INTEGER,hlc TEXT,PRIMARY KEY(kind,id,field,elem));
    CREATE TABLE IF NOT EXISTS presence(kind TEXT,id TEXT,present INTEGER,hlc TEXT,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS oplog(seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
  `);
}

function persistMeta() {
  const meta = unwrap(self.__crdtMeta()).result;
  exec("INSERT INTO meta(key,value) VALUES('meta',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [meta]);
}

// Upsert the register delta from an Apply* call; `ops` (local only) go to oplog.
function persistDelta(rows, ops) {
  txn(() => {
    upsertMany(
      'INSERT INTO fields(kind,id,field,value,hlc) VALUES(?,?,?,?,?) ON CONFLICT(kind,id,field) DO UPDATE SET value=excluded.value,hlc=excluded.hlc',
      rows.fields, (r) => [r.k, r.i, r.f, r.v, JSON.stringify(r.h)]
    );
    upsertMany(
      'INSERT INTO setelems(kind,id,field,elem,present,hlc) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id,field,elem) DO UPDATE SET present=excluded.present,hlc=excluded.hlc',
      rows.sets, (r) => [r.k, r.i, r.f, r.e, r.p ? 1 : 0, JSON.stringify(r.h)]
    );
    upsertMany(
      'INSERT INTO presence(kind,id,present,hlc) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET present=excluded.present,hlc=excluded.hlc',
      rows.presence, (r) => [r.k, r.i, r.p ? 1 : 0, JSON.stringify(r.h)]
    );
    upsertMany('INSERT INTO oplog(op) VALUES(?)', ops, (o) => [JSON.stringify(o)]);
    persistMeta();
  });
}

// Reconstruct the engine from SQLite rows (or start fresh on an empty DB).
function loadEngine() {
  const presence = {}, fields = {}, sets = {}, pending = [];
  db.exec({ sql: 'SELECT kind,id,present,hlc FROM presence', rowMode: 'array', callback: (r) => {
    presence[ek(r[0], r[1])] = { p: !!r[2], h: JSON.parse(r[3]) };
  } });
  db.exec({ sql: 'SELECT kind,id,field,value,hlc FROM fields', rowMode: 'array', callback: (r) => {
    const k = ek(r[0], r[1]);
    (fields[k] = fields[k] || {})[r[2]] = { v: r[3], h: JSON.parse(r[4]) };
  } });
  db.exec({ sql: 'SELECT kind,id,field,elem,present,hlc FROM setelems', rowMode: 'array', callback: (r) => {
    const k = ek(r[0], r[1]);
    const f = (sets[k] = sets[k] || {});
    (f[r[2]] = f[r[2]] || {})[r[3]] = { p: !!r[4], h: JSON.parse(r[5]) };
  } });
  db.exec({ sql: 'SELECT op FROM oplog ORDER BY seq', rowMode: 'array', callback: (r) => {
    pending.push(JSON.parse(r[0]));
  } });
  let meta = null;
  db.exec({ sql: "SELECT value FROM meta WHERE key='meta'", rowMode: 'array', callback: (r) => {
    meta = JSON.parse(r[0]);
  } });

  if (!meta) {
    unwrap(self.__crdtNew(''));
    persistMeta();
    return;
  }
  unwrap(self.__crdtLoad(JSON.stringify({
    node: meta.node, last: meta.last, cursor: meta.cursor || '', presence, fields, sets, pending,
  })));
}

// --- init: sqlite (OPFS) + Go WASM ------------------------------------------

async function init() {
  const sqlite3 = await self.sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'things3clone' });
  db = new pool.OpfsSAHPoolDb('/things.db');
  createSchema();

  const goReady = new Promise((resolve) => { self.__onCrdtReady = resolve; });
  const go = new Go();
  const res = await WebAssembly.instantiateStreaming(fetch('/crdt.wasm'), go.importObject).catch(async () => {
    const buf = await (await fetch('/crdt.wasm')).arrayBuffer();
    return WebAssembly.instantiate(buf, go.importObject);
  });
  go.run(res.instance); // runs main(), which calls __onCrdtReady
  await goReady;

  loadEngine();

  ready = true;
  const pendingMsgs = queue.splice(0);
  for (const m of pendingMsgs) handle(m);
  self.postMessage({ type: 'ready' });
}

// --- RPC --------------------------------------------------------------------

function handle(msg) {
  const { id, method, args = [] } = msg;
  try {
    let result;
    switch (method) {
      case 'info':
        result = { node: unwrap(self.__crdtNode()).result, hasData: unwrap(self.__crdtHasData()).result };
        break;
      case 'applyLocalSnapshot': {
        const parsed = JSON.parse(unwrap(self.__crdtApplyLocalSnapshot(args[0])).result);
        persistDelta(parsed.rows || {}, parsed.ops || []);
        result = { count: parsed.count };
        break;
      }
      case 'applyRemote': {
        const parsed = JSON.parse(unwrap(self.__crdtApplyRemote(args[0])).result);
        persistDelta(parsed.rows || {}, []); // remote ops don't re-enter the oplog
        result = { applied: parsed.applied, skipped: parsed.skipped };
        break;
      }
      case 'dropPending': {
        const n = args[0] | 0;
        unwrap(self.__crdtDropPending(n));
        txn(() => {
          exec('DELETE FROM oplog WHERE seq IN (SELECT seq FROM oplog ORDER BY seq LIMIT ?)', [n]);
          persistMeta();
        });
        result = true;
        break;
      }
      case 'materialize':
        result = unwrap(self.__crdtMaterialize()).result;
        break;
      case 'peekPending':
        result = unwrap(self.__crdtPeekPending()).result;
        break;
      case 'getCursor':
        result = unwrap(self.__crdtCursor()).result;
        break;
      case 'setCursor':
        unwrap(self.__crdtSetCursor(String(args[0] || '')));
        persistMeta();
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

init().catch((e) => self.postMessage({ type: 'fatal', error: String((e && e.message) || e) }));
