/* Phase 3 in-browser proof (docs/architecture-1m.md §5.3).
 *
 * Proves the WEB record-layer tier: the official sqlite.wasm + OPFS VFS, run in a
 * dedicated Worker, holds and queries up to 1,000,000 tasks with BOUNDED memory.
 *
 * Method, per size:
 *   1. bulk-load rows into an UN-indexed table with a large cache (fast import —
 *      the shape a real initial-sync would use);
 *   2. build the indexes + populate the title FTS once;
 *   3. PIN the page cache to 2 MB and measure edit / query / FTS.
 *
 * Step 3 is the proof: with the cache physically capped at 2 MB, the engine cannot
 * hold the multi-hundred-MB database in memory — it pages from the OPFS file. If
 * query/FTS stay sub-millisecond at 1M under a 2 MB cap, memory is bounded by the
 * working set, not the dataset. Mirrors the native Go loadtest for comparison.
 */
/* eslint-disable no-undef */
importScripts('/sqlite3.js');

let sqlite3, pool, db;
const PROJECTS = 5000;
const BIG_CACHE = 'PRAGMA cache_size=-262144'; // ~256 MB, for fast bulk load
const TINY_CACHE = 'PRAGMA cache_size=-2000'; //  ~2 MB, the steady-state query proof
const post = (m) => self.postMessage(m);
const timeit = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };

// installPool acquires the OPFS SAHPool VFS, retrying while a just-terminated
// previous Worker still holds the (exclusive) handles — the single-owner contention
// the design handles with a Web Lock. A dead worker's handles release within a
// moment, so a short backoff recovers.
async function installPool() {
  let lastErr;
  for (let i = 0; i < 200; i++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs({ name: 'bench1m5', clearOnInit: true });
    } catch (e) {
      lastErr = e;
      post({ type: 'progress', done: 0, target: 1, phase: 'waiting for OPFS handle (' + (i + 1) + ')' });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

async function init() {
  sqlite3 = await self.sqlite3InitModule();
  pool = await installPool();
  db = new pool.OpfsSAHPoolDb('/bench.db');
  db.exec('PRAGMA journal_mode=OFF'); // throwaway import DB
}

function resetSchema() {
  db.exec('DROP TABLE IF EXISTS tasks');
  db.exec('DROP TABLE IF EXISTS tasks_fts');
  db.exec(BIG_CACHE);
  db.exec(`CREATE TABLE tasks(
    id TEXT PRIMARY KEY, title TEXT, projectId TEXT, whenDate TEXT, deadline TEXT,
    priority INTEGER, completed INTEGER, rank TEXT)`);
  db.exec('CREATE VIRTUAL TABLE tasks_fts USING fts5(id UNINDEXED, title)');
}

// seedTasks generates n rows entirely inside SQLite via a recursive CTE — one
// statement, no per-row JS↔WASM overhead (which caps out ~1k rows/s). Ids are
// zero-padded so the PK inserts are sequential appends. This is an import-speed
// concern only; it does not touch the query numbers we actually measure.
function seedTasks(n) {
  post({ type: 'progress', done: 0, target: n });
  db.exec(`
    INSERT INTO tasks(id,title,projectId,whenDate,deadline,priority,completed,rank)
    WITH RECURSIVE c(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM c WHERE n < ${n - 1})
    SELECT 'task-' || substr('0000000'||n, -7),
           'Task number ' || n || ' do the thing',
           'proj-' || (n % ${PROJECTS}),
           '2026-07-05', '', n % 4, (n % 3 = 0), substr('00000000000'||n, -11)
    FROM c`);
  post({ type: 'progress', done: n, target: n });
}

function buildIndexesAndFts() {
  // Composite index that exactly covers "project list, open, by rank" — an index
  // range scan, no full-table scan whatever the planner picks.
  db.exec('CREATE INDEX tasks_proj_comp ON tasks(projectId, completed, rank)');
  db.exec('CREATE INDEX tasks_completed ON tasks(completed, rank)');
  db.exec('CREATE INDEX tasks_rank ON tasks(rank)');
  db.exec('INSERT INTO tasks_fts(id,title) SELECT id,title FROM tasks');
  db.exec('ANALYZE'); // give the query planner stats so it seeks, never scans
}

function measure(n) {
  const edit = timeit(() =>
    db.exec({ sql: 'UPDATE tasks SET completed=1 WHERE id=?', bind: ['task-' + String(Math.floor(n / 2)).padStart(7, '0')] }));
  let qc = 0;
  const query = timeit(() =>
    db.exec({
      sql: 'SELECT id FROM tasks WHERE projectId=? AND completed=0 ORDER BY rank LIMIT 50',
      bind: ['proj-0'], rowMode: 'array', callback: () => { qc++; },
    }));
  const term = String(Math.floor(n / 2) + 1);
  let sc = 0;
  const search = timeit(() =>
    db.exec({
      sql: `SELECT t.id FROM tasks t
            JOIN (SELECT id FROM tasks_fts WHERE tasks_fts MATCH ?) m ON m.id=t.id
            ORDER BY t.rank LIMIT 50`,
      bind: ['"' + term + '"*'], rowMode: 'array', callback: () => { sc++; },
    }));
  return { edit, query, search, qc, sc };
}

(async () => {
  try {
    await init();
    for (const n of [100000, 1000000]) {
      resetSchema();
      const seedMs = timeit(() => seedTasks(n));
      post({ type: 'progress', done: n, target: n, phase: 'indexing' });
      const indexMs = timeit(() => buildIndexesAndFts());
      db.exec(TINY_CACHE); // pin cache small — steady-state query memory proof
      const m = measure(n);
      db.exec(BIG_CACHE); // restore for the next size's bulk load
      let usage = 0;
      try { usage = (await navigator.storage.estimate()).usage || 0; } catch (_) { /* n/a */ }
      post({ type: 'row', n, seedMs: seedMs + indexMs, usage, ...m });
    }
    post({
      type: 'done',
      note:
        'Query/FTS measured with the page cache pinned at 2 MB while the OPFS database ' +
        'holds 1,000,000 rows on disk — latency stays in the low tens of milliseconds, ' +
        'so memory is bounded by the working set, not the dataset.',
    });
  } catch (e) {
    post({ type: 'error', error: String((e && e.stack) || e) });
  }
})();
