/* CRDT Web Worker — Phase 1: ygo (Yjs-in-Go) engine.
 *
 * Runs the Go-compiled WASM engine (crdt.wasm) off the main thread. The engine is
 * now core/ydoc (our wrapper over reearth/ygo), exposed as __ydoc* globals. State
 * is persisted as a single opaque Yjs snapshot blob (base64) in SQLite on the OPFS
 * SAHPool VFS — the same durable substrate as before, far simpler shape.
 *
 * On first run after the migration, if the old field-level register tables hold
 * data but there is no ygo snapshot yet, we materialize the old engine (__crdt*,
 * still compiled in) and seed the new ygo document from it — a one-time, in-place
 * migration. Any failure there falls back to a fresh empty replica; startup never
 * blocks.
 *
 * The main thread (src/store/crdtClient.js) drives this over a tiny postMessage
 * RPC. See docs/crdt-ygo.md.
 */
/* eslint-disable no-undef */
importScripts('/wasm_exec.js', '/sqlite3.js');

const US = '\x1f';
const ek = (kind, id) => kind + US + id;

let db = null; // sqlite oo1 DB (OPFS-backed); ONE file, one OPFS access handle
let currentWs = 'local'; // active workspace id ('local' = signed-out/personal)
let ready = false;
const queue = [];

function unwrap(r) {
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'wasm call failed');
  return r;
}

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

function createSchema() {
  // One row PER WORKSPACE (keyed by workspace id) so each workspace keeps its own
  // ygo snapshot in the SAME database file — switching workspaces reloads a
  // different row rather than opening another OPFS file (which trips SAHPool's
  // exclusive access handles). The legacy `ydoc` (single id=1 row) and the old
  // register tables may still exist from earlier installs; we read them once for
  // migration but never write them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ydocws(workspace TEXT PRIMARY KEY, clientid TEXT, snapshot TEXT);
    CREATE TABLE IF NOT EXISTS ydoc(id INTEGER PRIMARY KEY CHECK(id=1), clientid TEXT, snapshot TEXT);
  `);
}

// Persist the current ygo document (client id + full-state snapshot) for the
// active workspace.
function persist() {
  const clientid = unwrap(self.__ydocClientID()).result;
  const snapshot = unwrap(self.__ydocEncodeAll()).result;
  exec(
    "INSERT INTO ydocws(workspace,clientid,snapshot) VALUES(?,?,?) ON CONFLICT(workspace) DO UPDATE SET clientid=excluded.clientid,snapshot=excluded.snapshot",
    [currentWs, clientid, snapshot]
  );
}

// If the legacy register tables hold data, rebuild the old engine, materialize it,
// and seed the new ygo document. Returns true if a migration happened.
function migrateLegacy() {
  const tableExists = (name) => {
    let n = 0;
    db.exec({ sql: "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", bind: [name], rowMode: 'array', callback: (r) => { n = r[0]; } });
    return n > 0;
  };
  if (!tableExists('presence')) return false;
  let count = 0;
  db.exec({ sql: 'SELECT count(*) FROM presence WHERE present=1', rowMode: 'array', callback: (r) => { count = r[0]; } });
  if (!count) return false;

  // Rebuild the legacy engine from its rows (mirrors the old loadEngine).
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
  let meta = null;
  db.exec({ sql: "SELECT value FROM meta WHERE key='meta'", rowMode: 'array', callback: (r) => { meta = JSON.parse(r[0]); } });
  unwrap(self.__crdtLoad(JSON.stringify({
    node: (meta && meta.node) || '', last: (meta && meta.last) || null,
    cursor: (meta && meta.cursor) || '', presence, fields, sets, pending,
  })));
  const stateJSON = unwrap(self.__crdtMaterialize()).result;

  // Seed a fresh ygo document from the materialized legacy state.
  unwrap(self.__ydocNew(''));
  unwrap(self.__ydocApplyLocalSnapshot(stateJSON));
  persist();
  return true;
}

// Migrate the pre-workspace single-row `ydoc(id=1)` snapshot into the 'local'
// workspace row. Returns true if it loaded something.
function migrateOldYdoc() {
  let row = null;
  try {
    db.exec({ sql: 'SELECT clientid,snapshot FROM ydoc WHERE id=1', rowMode: 'array', callback: (r) => {
      row = { clientid: r[0], snapshot: r[1] };
    } });
  } catch (_) { /* table may not exist */ }
  if (!row) return false;
  unwrap(self.__ydocLoad(row.clientid, row.snapshot || ''));
  persist(); // copy into ydocws(currentWs)
  return true;
}

// Reconstruct the ygo engine for the ACTIVE workspace (or migrate / start fresh).
function loadEngine() {
  let row = null;
  db.exec({ sql: 'SELECT clientid,snapshot FROM ydocws WHERE workspace=?', bind: [currentWs], rowMode: 'array', callback: (r) => {
    row = { clientid: r[0], snapshot: r[1] };
  } });
  if (row) {
    unwrap(self.__ydocLoad(row.clientid, row.snapshot || ''));
    return;
  }
  // No snapshot for this workspace yet. Only 'local' can inherit pre-workspace
  // data (the old single-row snapshot, then the legacy register tables).
  if (currentWs === 'local') {
    try { if (migrateOldYdoc()) return; } catch (e) { /* fall through */ }
    try { if (migrateLegacy()) return; } catch (e) { /* fall through */ }
  }
  unwrap(self.__ydocNew(''));
  persist();
}

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

function handle(msg) {
  const { id, method, args = [] } = msg;
  try {
    let result;
    switch (method) {
      case 'info':
        result = { clientID: unwrap(self.__ydocClientID()).result, hasData: unwrap(self.__ydocHasData()).result };
        break;
      case 'applyLocalSnapshot':
        unwrap(self.__ydocApplyLocalSnapshot(args[0]));
        txn(() => persist());
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
        txn(() => persist());
        result = true;
        break;
      case 'hasData':
        result = unwrap(self.__ydocHasData()).result;
        break;
      case 'useWorkspace': {
        // Switch the active workspace: reload the in-memory engine from that
        // workspace's row in the SAME database. No file open/close (which would
        // trip OPFS access handles), no cross-mixing of workspace data.
        const ws = String(args[0] || 'local');
        if (ws !== currentWs) {
          currentWs = ws;
          loadEngine();
        }
        result = { workspace: currentWs };
        break;
      }
      case 'reset':
        // Wipe the active workspace's snapshot and start a brand-new empty replica.
        // (Clearing OPFS from DevTools doesn't touch this SQLite DB; this does.)
        txn(() => { exec('DELETE FROM ydocws WHERE workspace=?', [currentWs]); });
        unwrap(self.__ydocNew(''));
        txn(() => persist());
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

self.onmessage = (ev) => {
  if (!ready) queue.push(ev.data);
  else handle(ev.data);
};

init().catch((e) => self.postMessage({ type: 'fatal', error: String((e && e.message) || e) }));
