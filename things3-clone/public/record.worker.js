/* Web record adapter — the JS twin of core/record (docs/architecture-1m.md §5.3).
 *
 * Runs the official sqlite.wasm + OPFS VFS in this dedicated Worker and exposes the
 * RecordStore query API (paged reads + per-entity writes + title FTS) over a
 * postMessage RPC. Same schema, SQL, CRDT semantics (LWW + HLC + op-log) and op
 * wire-format as the native Go engine, so the two stay protocol-compatible.
 *
 * Bakes in the Phase-3 learnings (docs/perf-benchmarks.md §5):
 *   - single owner via a Web Lock held for the worker's lifetime (+ install retry);
 *   - composite index (projectId, completed, rank) + ANALYZE so views never scan;
 *   - steady-state page cache pinned small (bounded memory);
 *   - set-based bulk hydrate for import.
 */
/* eslint-disable no-undef */
importScripts('/sqlite3.js');

const DB_FILE = '/things-record.db';
const POOL = 'things3record';
let sqlite3, pool, db;
let node = '';
let last = { wall: 0, ctr: 0, node: '' };
let rankCtr = 0;

const post = (m) => self.postMessage(m);

// ---- sqlite helpers ----
function run(sql, bind) { db.exec(bind ? { sql, bind } : sql); }
function all(sql, bind) {
  const rows = [];
  db.exec({ sql, bind: bind || [], rowMode: 'object', resultRows: rows });
  return rows;
}
function one(sql, bind) { const r = all(sql, bind); return r.length ? r[0] : null; }

// ---- HLC (wire-compatible "wall.ctr.node") ----
function hlcStr(h) { return h.wall + '.' + h.ctr + '.' + h.node; }
function stamp() {
  const w = Date.now();
  if (w > last.wall) last = { wall: w, ctr: 0, node };
  else last = { wall: last.wall, ctr: last.ctr + 1, node };
  return hlcStr(last);
}

// ---- canonical JSON of a value (scalars match Go's canon; nested-key-sort is a
// Phase-5 concern, only needed once JS and Go replicas sync). ----
function canon(v) { return JSON.stringify(v); }
function decode(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// ---- fractional ranks (mirror core/record/rank.go) ----
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function pad62(n) {
  let s = '';
  for (let i = 0; i < 11; i++) { s = DIGITS[n % 62] + s; n = Math.floor(n / 62); }
  return s;
}
function rankBetween(a, b) {
  let out = '';
  for (let i = 0; ; i++) {
    const va = i < a.length ? DIGITS.indexOf(a[i]) : 0;
    let vb = DIGITS.length;
    if (b && i < b.length) vb = DIGITS.indexOf(b[i]);
    if (va === vb) { out += DIGITS[va]; continue; }
    const mid = (va + vb) >> 1;
    if (mid > va) return out + DIGITS[mid];
    out += DIGITS[va];
    b = '';
  }
}
function nextRank() { rankCtr += 1; return pad62(rankCtr); }

// ---- schema ----
function migrate() {
  run('PRAGMA journal_mode=WAL');
  run(`CREATE TABLE IF NOT EXISTS fields (kind TEXT, id TEXT, field TEXT, value TEXT, hlc TEXT, PRIMARY KEY(kind,id,field))`);
  run(`CREATE TABLE IF NOT EXISTS setelems (kind TEXT, id TEXT, field TEXT, elem TEXT, present INTEGER, hlc TEXT, PRIMARY KEY(kind,id,field,elem))`);
  run(`CREATE TABLE IF NOT EXISTS presence (kind TEXT, id TEXT, present INTEGER, hlc TEXT, PRIMARY KEY(kind,id))`);
  run(`CREATE TABLE IF NOT EXISTS oplog (seq INTEGER PRIMARY KEY AUTOINCREMENT, optype TEXT, kind TEXT, id TEXT, field TEXT DEFAULT '', elem TEXT DEFAULT '', value TEXT DEFAULT '', present INTEGER DEFAULT 0, hlc TEXT, synced INTEGER DEFAULT 0)`);
  run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  run(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT DEFAULT '', projectId TEXT DEFAULT '', whenDate TEXT DEFAULT '', deadline TEXT DEFAULT '', priority INTEGER DEFAULT 0, completed INTEGER DEFAULT 0, status TEXT DEFAULT 'open', parentId TEXT DEFAULT '', ord REAL DEFAULT 0, rank TEXT DEFAULT '', notesPreview TEXT DEFAULT '')`);
  run('CREATE INDEX IF NOT EXISTS tasks_proj_comp ON tasks(projectId, completed, rank)');
  run('CREATE INDEX IF NOT EXISTS tasks_status_ord ON tasks(status, ord)');
  run('CREATE INDEX IF NOT EXISTS tasks_rank ON tasks(rank)');
  run(`CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(id UNINDEXED, title)`);
  node = metaGet('node') || ('web-' + Math.random().toString(16).slice(2, 10));
  metaSet('node', node);
  last = parseHLC(metaGet('hlc'));
  last.node = node;
  rankCtr = parseInt(metaGet('rankctr') || '0', 10) || 0;
}
function parseHLC(s) {
  const p = (s || '').split('.');
  return p.length === 3 ? { wall: +p[0] || 0, ctr: +p[1] || 0, node: p[2] } : { wall: 0, ctr: 0, node };
}
function metaGet(k) { const r = one('SELECT value FROM meta WHERE key=?', [k]); return r ? r.value : null; }
function metaSet(k, v) { run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [k, String(v)]); }
function saveState() { metaSet('hlc', hlcStr(last)); metaSet('rankctr', rankCtr); }

// ---- op application (LWW) + reproject ----
function applyOp(op, local) {
  let applied = false;
  const h = op.hlc;
  if (op.type === 'presence') {
    const cur = one('SELECT hlc FROM presence WHERE kind=? AND id=?', [op.kind, op.id]);
    if (!cur || hlcAfter(h, cur.hlc)) {
      run('INSERT INTO presence(kind,id,present,hlc) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET present=excluded.present, hlc=excluded.hlc', [op.kind, op.id, op.present ? 1 : 0, h]);
      applied = true;
    }
  } else if (op.type === 'field') {
    const cur = one('SELECT hlc FROM fields WHERE kind=? AND id=? AND field=?', [op.kind, op.id, op.field]);
    if (!cur || hlcAfter(h, cur.hlc)) {
      run('INSERT INTO fields(kind,id,field,value,hlc) VALUES(?,?,?,?,?) ON CONFLICT(kind,id,field) DO UPDATE SET value=excluded.value, hlc=excluded.hlc', [op.kind, op.id, op.field, op.value, h]);
      applied = true;
    }
  } else if (op.type === 'set') {
    const cur = one('SELECT hlc FROM setelems WHERE kind=? AND id=? AND field=? AND elem=?', [op.kind, op.id, op.field, op.elem]);
    if (!cur || hlcAfter(h, cur.hlc)) {
      run('INSERT INTO setelems(kind,id,field,elem,present,hlc) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id,field,elem) DO UPDATE SET present=excluded.present, hlc=excluded.hlc', [op.kind, op.id, op.field, op.elem, op.present ? 1 : 0, h]);
      applied = true;
    }
  }
  if (local && applied) {
    run('INSERT INTO oplog(optype,kind,id,field,elem,value,present,hlc,synced) VALUES(?,?,?,?,?,?,?,?,0)',
      [op.type, op.kind, op.id, op.field || '', op.elem || '', op.value || '', op.present ? 1 : 0, h]);
  }
  return applied;
}
function hlcAfter(a, b) {
  const x = parseHLC(a), y = parseHLC(b);
  if (x.wall !== y.wall) return x.wall > y.wall;
  if (x.ctr !== y.ctr) return x.ctr > y.ctr;
  return x.node > y.node;
}

function reproject(id, ftsDirty) {
  const p = one("SELECT present FROM presence WHERE kind='task' AND id=?", [id]);
  if (!p || p.present === 0) {
    run('DELETE FROM tasks WHERE id=?', [id]);
    run('DELETE FROM tasks_fts WHERE id=?', [id]);
    return;
  }
  const f = {};
  for (const r of all("SELECT field,value FROM fields WHERE kind='task' AND id=?", [id])) f[r.field] = r.value;
  const title = decode(f.title) || '';
  const notes = decode(f.notes) || '';
  // The app models completion as `status` (open/completed/canceled/trashed); keep a
  // derived `completed` flag too. Order mirrors the app's numeric `order`.
  const status = decode(f.status) || (decode(f.completed) ? 'completed' : 'open');
  const ord = Number(decode(f.order));
  run(`INSERT INTO tasks(id,title,projectId,whenDate,deadline,priority,completed,status,parentId,ord,rank,notesPreview)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, projectId=excluded.projectId,
         whenDate=excluded.whenDate, deadline=excluded.deadline, priority=excluded.priority,
         completed=excluded.completed, status=excluded.status, parentId=excluded.parentId,
         ord=excluded.ord, rank=excluded.rank, notesPreview=excluded.notesPreview`,
    [id, title, decode(f.projectId) || '', decode(f.when) || '', decode(f.deadline) || '',
      decode(f.priority) || 0, status === 'completed' ? 1 : 0, status, decode(f.parentId) || '',
      Number.isFinite(ord) ? ord : 0, decode(f.rank) || '', notes.slice(0, 120)]);
  if (!ftsDirty) return;
  run('DELETE FROM tasks_fts WHERE id=?', [id]);
  run('INSERT INTO tasks_fts(id,title) VALUES(?,?)', [id, title]);
}

// ---- writes (each a transaction) ----
function writeOps(ops, taskId, ftsDirty) {
  run('BEGIN');
  try {
    for (const op of ops) { op.hlc = stamp(); applyOp(op, true); }
    if (taskId) reproject(taskId, ftsDirty);
    saveState();
    run('COMMIT');
  } catch (e) { run('ROLLBACK'); throw e; }
}
function fieldOp(id, field, value) { return { type: 'field', kind: 'task', id, field, value: canon(value) }; }

function createTask(t) {
  const id = t.id || 'task-' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
  const rank = t.rank || nextRank();
  const ops = [
    { type: 'presence', kind: 'task', id, present: true },
    fieldOp(id, 'title', t.title || ''), fieldOp(id, 'projectId', t.projectId || ''),
    fieldOp(id, 'when', t.when || ''), fieldOp(id, 'deadline', t.deadline || ''),
    fieldOp(id, 'priority', t.priority || 0), fieldOp(id, 'completed', !!t.completed),
    fieldOp(id, 'status', t.status || 'open'), fieldOp(id, 'parentId', t.parentId || ''),
    fieldOp(id, 'order', t.order != null ? t.order : 0),
    fieldOp(id, 'notes', t.notes || ''), fieldOp(id, 'rank', rank),
  ];
  for (const tag of t.tags || []) ops.push({ type: 'set', kind: 'task', id, field: 'tags', elem: canon(tag), present: true });
  writeOps(ops, id, true);
  return id;
}
function setTaskField(id, field, value) {
  writeOps([fieldOp(id, field, value)], id, field === 'title');
}
function toggleComplete(id, completed) { writeOps([fieldOp(id, 'completed', !!completed)], id, false); }
function moveTask(id, beforeId, afterId) {
  const prev = beforeId ? (one('SELECT rank FROM tasks WHERE id=?', [beforeId]) || {}).rank || '' : '';
  const next = afterId ? (one('SELECT rank FROM tasks WHERE id=?', [afterId]) || {}).rank || '' : '';
  writeOps([fieldOp(id, 'rank', rankBetween(prev, next))], id, false);
}
function deleteTask(id) { writeOps([{ type: 'presence', kind: 'task', id, present: false }], id, false); }

// ---- reads ----
const FILTER_COLS = { projectId: 'projectId', priority: 'priority', when: 'whenDate', deadline: 'deadline', completed: 'completed', rank: 'rank' };
const SCALAR_OPS = { '=': 1, '!=': 1, '<>': 1, '>': 1, '<': 1, '>=': 1, '<=': 1 };
function whereOf(q, alias) {
  const parts = [], args = [];
  const col = (n) => (alias || '') + n;
  if (q.projectId) { parts.push(col('projectId') + '=?'); args.push(q.projectId); }
  if (q.when) { parts.push(col('whenDate') + '=?'); args.push(q.when); }
  if (q.onlyOpen) parts.push(col('completed') + '=0');
  if (q.onlyComplete) parts.push(col('completed') + '=1');
  for (const c of q.conditions || []) {
    const column = FILTER_COLS[c.field];
    if (!column) throw new Error('record: unknown filter field ' + c.field);
    const op = String(c.op || '').toLowerCase().trim();
    if (op === 'in' || op === 'not in') {
      if (!c.values || !c.values.length) { if (op === 'in') parts.push('0=1'); continue; }
      parts.push(col(column) + ' ' + (op === 'in' ? 'IN' : 'NOT IN') + ' (' + c.values.map(() => '?').join(',') + ')');
      for (const v of c.values) args.push(normVal(v));
    } else {
      if (!SCALAR_OPS[op]) throw new Error('record: unsupported op ' + c.op);
      if (!c.values || c.values.length !== 1) throw new Error('record: op ' + c.op + ' needs one value');
      parts.push(col(column) + ' ' + op + ' ?'); args.push(normVal(c.values[0]));
    }
  }
  return { clause: parts.length ? ' WHERE ' + parts.join(' AND ') : '', args };
}
function normVal(v) { return typeof v === 'boolean' ? (v ? 1 : 0) : v; }
const COLS = 'id,title,projectId,whenDate AS "when",deadline,priority,completed,rank';
function toRow(r) { r.completed = !!r.completed; return r; }

function queryTasks(q) {
  q = q || {};
  const { clause, args } = whereOf(q, '');
  let sql = `SELECT ${COLS} FROM tasks` + clause + ' ORDER BY rank, id';
  if (q.limit) sql += ` LIMIT ${q.limit | 0} OFFSET ${q.offset | 0}`;
  return all(sql, args).map(toRow);
}
function searchTasks(text, q) {
  q = q || {};
  const { clause, args } = whereOf(q, 't.');
  let sql = `SELECT t.id,t.title,t.projectId,t.whenDate AS "when",t.deadline,t.priority,t.completed,t.rank
             FROM tasks t JOIN (SELECT id FROM tasks_fts WHERE tasks_fts MATCH ?) m ON m.id=t.id` +
    clause + ' ORDER BY t.rank, t.id';
  if (q.limit) sql += ` LIMIT ${q.limit | 0} OFFSET ${q.offset | 0}`;
  return all(sql, [ftsQuery(text)].concat(args)).map(toRow);
}
function ftsQuery(text) {
  const toks = String(text || '').split(/\s+/).filter(Boolean).map((t) => '"' + t.replace(/"/g, '') + '"*');
  return toks.length ? toks.join(' ') : '""';
}
function countTasks(q) {
  const { clause, args } = whereOf(q || {}, '');
  return (one('SELECT COUNT(*) AS n FROM tasks' + clause, args) || { n: 0 }).n;
}

// queryList runs a smart-list query in SQL (mirrors src/store/selectors.js). Starts
// with 'today'; other lists fall back to the in-memory selector until ported.
function queryList(listId, params) {
  params = params || {};
  if (listId === 'today') {
    const today = params.todayKey || '';
    return all(`SELECT ${COLS} FROM tasks
      WHERE status='open' AND (parentId IS NULL OR parentId='')
        AND ( whenDate IN ('today','evening')
              OR (whenDate LIKE '____-__-__' AND whenDate <= ?)
              OR (deadline LIKE '____-__-__' AND deadline <= ?) )
      ORDER BY ord, id`, [today, today]).map(toRow);
  }
  throw new Error('record: queryList unsupported list ' + listId);
}
function getTask(id) {
  const p = one("SELECT present FROM presence WHERE kind='task' AND id=?", [id]);
  if (!p || p.present === 0) return null;
  const obj = { id };
  for (const r of all("SELECT field,value FROM fields WHERE kind='task' AND id=?", [id])) obj[r.field] = decode(r.value);
  obj.tags = all("SELECT elem FROM setelems WHERE kind='task' AND id=? AND field='tags' AND present=1", [id]).map((r) => decode(r.elem));
  return obj;
}

// hydrate — one-time bulk import from the app's current state (set-based, batched).
function hydrate(tasks) {
  run('BEGIN');
  try {
    for (const t of tasks) {
      if (!t.id) continue;
      const rank = t.rank || (t.order != null ? pad62(Math.max(0, Math.round(t.order))) : nextRank());
      for (const op of [
        { type: 'presence', kind: 'task', id: t.id, present: true },
        fieldOp(t.id, 'title', t.title || ''), fieldOp(t.id, 'projectId', t.projectId || ''),
        fieldOp(t.id, 'when', t.when || ''), fieldOp(t.id, 'deadline', t.deadline || ''),
        fieldOp(t.id, 'priority', t.priority || 0), fieldOp(t.id, 'completed', !!t.completed),
        fieldOp(t.id, 'status', t.status || 'open'), fieldOp(t.id, 'parentId', t.parentId || ''),
        fieldOp(t.id, 'order', t.order != null ? t.order : 0),
        fieldOp(t.id, 'notes', t.notes || ''), fieldOp(t.id, 'rank', rank),
      ]) { op.hlc = stamp(); applyOp(op, true); }
      for (const tag of t.tags || []) { const op = { type: 'set', kind: 'task', id: t.id, field: 'tags', elem: canon(tag), present: true, hlc: stamp() }; applyOp(op, true); }
      reproject(t.id, true);
    }
    saveState();
    run('COMMIT');
  } catch (e) { run('ROLLBACK'); throw e; }
  run('ANALYZE');
  return countTasks({});
}

// ---- single-owner init (Web Lock held for the worker's lifetime + install retry) ----
async function acquireOwnership() {
  if (!(self.navigator && navigator.locks)) return; // fallback: rely on install retry
  await new Promise((ready) => {
    navigator.locks.request('things3-record-owner', () => {
      ready();
      return new Promise(() => {}); // hold the lock until this worker dies
    });
  });
}
async function installPool() {
  let lastErr;
  for (let i = 0; i < 40; i++) {
    try { return await sqlite3.installOpfsSAHPoolVfs({ name: POOL }); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 300)); }
  }
  throw lastErr;
}
async function init() {
  sqlite3 = await self.sqlite3InitModule();
  await acquireOwnership();
  pool = await installPool();
  db = new pool.OpfsSAHPoolDb(DB_FILE);
  run('PRAGMA cache_size=-4000'); // ~4 MB steady-state cache — bounded memory
  migrate();
}

// ---- RPC ----
const handlers = {
  hydrate: (tasks) => hydrate(tasks),
  hasData: () => countTasks({}) > 0,
  queryTasks: (q) => queryTasks(q),
  queryList: (listId, params) => queryList(listId, params),
  searchTasks: (text, q) => searchTasks(text, q),
  countTasks: (q) => countTasks(q),
  getTask: (id) => getTask(id),
  createTask: (t) => createTask(t),
  setTaskField: (id, field, value) => setTaskField(id, field, value),
  toggleComplete: (id, completed) => toggleComplete(id, completed),
  moveTask: (id, beforeId, afterId) => moveTask(id, beforeId, afterId),
  deleteTask: (id) => deleteTask(id),
  reset: () => { run('DELETE FROM fields; DELETE FROM setelems; DELETE FROM presence; DELETE FROM oplog; DELETE FROM tasks; DELETE FROM tasks_fts;'); return true; },
};

let ready = false;
const queue = [];
self.onmessage = (ev) => {
  if (!ready) { queue.push(ev.data); return; }
  dispatch(ev.data);
};
function dispatch(msg) {
  const { id, method, args = [] } = msg;
  try {
    const fn = handlers[method];
    if (!fn) throw new Error('unknown method: ' + method);
    post({ id, ok: true, result: fn.apply(null, args) });
  } catch (e) {
    post({ id, ok: false, error: String((e && e.message) || e) });
  }
}

init().then(() => {
  ready = true;
  for (const m of queue.splice(0)) dispatch(m);
  post({ type: 'ready' });
}).catch((e) => post({ type: 'fatal', error: String((e && e.stack) || e) }));
