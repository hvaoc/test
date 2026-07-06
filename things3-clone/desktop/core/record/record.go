// Package record is the query-oriented, 1M-scale record layer from
// docs/architecture-1m.md §3. It is the scalable half of the two-layer design: the
// database of tasks/projects/areas and their structured fields.
//
// It keeps the proven field-level CRDT semantics (per-field Last-Writer-Wins
// registers + add-wins sets + presence tombstones, stamped with Hybrid Logical
// Clocks, pushed as an op-log) but exposes a QUERY API instead of whole-workspace
// snapshots — so memory is bounded by the visible page, a single edit is O(1)
// instead of O(dataset), and search/filter run as indexed SQLite + FTS5 offline.
//
// Two kinds of table:
//   - CRDT source of truth: fields, setelems, presence, oplog, meta.
//   - Derived read-model (rebuildable from the above): tasks + tasks_fts, kept in
//     sync inside the same transaction as every write, so queries hit indexes while
//     merge stays register-based.
//
// The rich-text notes body ultimately lives in the per-task ygo document (Phase 4);
// here we keep a searchable copy so offline full-text search works.
package record

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver (no cgo → gomobile-friendly)
)

// Store owns the SQLite handle + HLC clock and serialises writes.
type Store struct {
	mu      sync.Mutex
	db      *sql.DB
	node    string
	clk     *clock
	rankCtr uint64 // monotonic append-order counter (persisted in meta)
	now     func() int64
}

// Open creates/opens the database at path (":memory:" for tests).
func Open(path string) (*Store, error) {
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer keeps CRDT apply race-free
	s := &Store{db: db, now: func() int64 { return time.Now().UnixMilli() }}
	if err := s.migrate(); err != nil {
		return nil, err
	}
	s.node = s.ensureNode()
	s.clk = &clock{node: s.node, last: s.loadClock(), now: func() int64 { return s.now() }}
	s.rankCtr = s.loadRankCtr()
	return s, nil
}

// nextRank returns the next append-order key (monotonic). Caller holds s.mu; the
// bumped counter is persisted by saveClockTx in the same transaction.
func (s *Store) nextRank() string {
	s.rankCtr++
	return Pad62(s.rankCtr)
}

func (s *Store) loadRankCtr() uint64 {
	var v string
	if err := s.db.QueryRow(`SELECT value FROM meta WHERE key='rankctr'`).Scan(&v); err == nil {
		n, _ := strconv.ParseUint(v, 10, 64)
		return n
	}
	return 0
}

func (s *Store) Close() error { return s.db.Close() }
func (s *Store) Node() string { return s.node }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS fields (
  kind TEXT NOT NULL, id TEXT NOT NULL, field TEXT NOT NULL,
  value TEXT NOT NULL, hlc TEXT NOT NULL,
  PRIMARY KEY (kind, id, field)
);
CREATE TABLE IF NOT EXISTS setelems (
  kind TEXT NOT NULL, id TEXT NOT NULL, field TEXT NOT NULL, elem TEXT NOT NULL,
  present INTEGER NOT NULL, hlc TEXT NOT NULL,
  PRIMARY KEY (kind, id, field, elem)
);
CREATE TABLE IF NOT EXISTS presence (
  kind TEXT NOT NULL, id TEXT NOT NULL, present INTEGER NOT NULL, hlc TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS oplog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  optype TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  field TEXT NOT NULL DEFAULT '', elem TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '', present INTEGER NOT NULL DEFAULT 0,
  hlc TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS oplog_unsynced ON oplog(seq) WHERE synced = 0;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Derived read-model for tasks (rebuildable from fields/presence). Mirrors the app
-- shape: completion is status (open/completed/canceled/trashed) with a derived
-- completed flag; ord mirrors the app's numeric order for smart-list queries.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  projectId TEXT NOT NULL DEFAULT '',
  whenDate TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  parentId TEXT NOT NULL DEFAULT '',
  ord REAL NOT NULL DEFAULT 0,
  rank TEXT NOT NULL DEFAULT '',
  notesPreview TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tasks_rank ON tasks(rank);
CREATE INDEX IF NOT EXISTS tasks_proj_comp ON tasks(projectId, completed, rank);
CREATE INDEX IF NOT EXISTS tasks_status_ord ON tasks(status, ord);
CREATE INDEX IF NOT EXISTS tasks_completed ON tasks(completed, rank);

-- Full-text search over title + notes (offline). id UNINDEXED lets us map hits
-- back to a task and re-sync a single row.
-- Title-only, word-prefix search (FTS5 default tokenizer). Notes are intentionally
-- NOT searchable; every other field filters via indexed SQL comparison operators,
-- not FTS. (Future: 'trigram' tokenizer for substring/contains — see
-- docs/architecture-1m.md §3.)
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(id UNINDEXED, title);
`)
	return err
}

// ---- canonical JSON (byte-identical to core.canon / crdt.js canon) ----

func canonAny(v any) string {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return ""
	}
	return strings.TrimRight(buf.String(), "\n")
}

func asString(canonJSON string) string {
	var s string
	_ = json.Unmarshal([]byte(canonJSON), &s)
	return s
}
func asInt(canonJSON string) int64 { var n int64; _ = json.Unmarshal([]byte(canonJSON), &n); return n }
func asBool(canonJSON string) bool { var b bool; _ = json.Unmarshal([]byte(canonJSON), &b); return b }
func asFloat(canonJSON string) float64 {
	var n float64
	_ = json.Unmarshal([]byte(canonJSON), &n)
	return n
}

// ---- op application (LWW) ----

func applyOpTx(tx *sql.Tx, op Op, local bool) (bool, error) {
	applied := false
	switch op.Type {
	case "presence":
		var cur string
		err := tx.QueryRow(`SELECT hlc FROM presence WHERE kind=? AND id=?`, op.Kind, op.ID).Scan(&cur)
		if err == sql.ErrNoRows || (err == nil && op.HLC.After(parseHLC(cur))) {
			if _, e := tx.Exec(`INSERT INTO presence(kind,id,present,hlc) VALUES(?,?,?,?)
				ON CONFLICT(kind,id) DO UPDATE SET present=excluded.present, hlc=excluded.hlc`,
				op.Kind, op.ID, b2i(op.Present), op.HLC.String()); e != nil {
				return false, e
			}
			applied = true
		} else if err != nil {
			return false, err
		}
	case "field":
		var cur string
		err := tx.QueryRow(`SELECT hlc FROM fields WHERE kind=? AND id=? AND field=?`, op.Kind, op.ID, op.Field).Scan(&cur)
		if err == sql.ErrNoRows || (err == nil && op.HLC.After(parseHLC(cur))) {
			if _, e := tx.Exec(`INSERT INTO fields(kind,id,field,value,hlc) VALUES(?,?,?,?,?)
				ON CONFLICT(kind,id,field) DO UPDATE SET value=excluded.value, hlc=excluded.hlc`,
				op.Kind, op.ID, op.Field, op.Value, op.HLC.String()); e != nil {
				return false, e
			}
			applied = true
		} else if err != nil {
			return false, err
		}
	case "set":
		var cur string
		err := tx.QueryRow(`SELECT hlc FROM setelems WHERE kind=? AND id=? AND field=? AND elem=?`, op.Kind, op.ID, op.Field, op.Elem).Scan(&cur)
		if err == sql.ErrNoRows || (err == nil && op.HLC.After(parseHLC(cur))) {
			if _, e := tx.Exec(`INSERT INTO setelems(kind,id,field,elem,present,hlc) VALUES(?,?,?,?,?,?)
				ON CONFLICT(kind,id,field,elem) DO UPDATE SET present=excluded.present, hlc=excluded.hlc`,
				op.Kind, op.ID, op.Field, op.Elem, b2i(op.Present), op.HLC.String()); e != nil {
				return false, e
			}
			applied = true
		} else if err != nil {
			return false, err
		}
	}
	if local && applied {
		if _, e := tx.Exec(`INSERT INTO oplog(optype,kind,id,field,elem,value,present,hlc,synced)
			VALUES(?,?,?,?,?,?,?,?,0)`,
			op.Type, op.Kind, op.ID, op.Field, op.Elem, op.Value, b2i(op.Present), op.HLC.String()); e != nil {
			return false, e
		}
	}
	return applied, nil
}

// reprojectTaskTx rebuilds the tasks read-model row for one task from the CRDT
// source of truth. Called after every write that touches a task. The FTS row is
// rewritten only when ftsDirty (title/notes changed or the task was created/
// deleted) — most edits (complete, priority, date, reorder) don't touch searchable
// text, so they skip the FTS delete/insert entirely and stay O(log n).
func reprojectTaskTx(tx *sql.Tx, id string, ftsDirty bool) error {
	var present int
	err := tx.QueryRow(`SELECT present FROM presence WHERE kind='task' AND id=?`, id).Scan(&present)
	if err == sql.ErrNoRows || (err == nil && present == 0) {
		if _, e := tx.Exec(`DELETE FROM tasks WHERE id=?`, id); e != nil {
			return e
		}
		_, e := tx.Exec(`DELETE FROM tasks_fts WHERE id=?`, id)
		return e
	} else if err != nil {
		return err
	}

	rows, err := tx.Query(`SELECT field,value FROM fields WHERE kind='task' AND id=?`, id)
	if err != nil {
		return err
	}
	f := map[string]string{}
	for rows.Next() {
		var field, value string
		if err := rows.Scan(&field, &value); err != nil {
			rows.Close()
			return err
		}
		f[field] = value
	}
	rows.Close()

	notes := asString(f["notes"])
	status := asString(f["status"])
	if status == "" { // derive from the legacy completed flag for older data
		if asBool(f["completed"]) {
			status = "completed"
		} else {
			status = "open"
		}
	}
	if _, e := tx.Exec(`INSERT INTO tasks(id,title,projectId,whenDate,deadline,priority,completed,status,parentId,ord,rank,notesPreview)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET title=excluded.title, projectId=excluded.projectId,
		  whenDate=excluded.whenDate, deadline=excluded.deadline, priority=excluded.priority,
		  completed=excluded.completed, status=excluded.status, parentId=excluded.parentId,
		  ord=excluded.ord, rank=excluded.rank, notesPreview=excluded.notesPreview`,
		id, asString(f["title"]), asString(f["projectId"]), asString(f["when"]),
		asString(f["deadline"]), asInt(f["priority"]), b2i(status == "completed"),
		status, asString(f["parentId"]), asFloat(f["order"]),
		asString(f["rank"]), preview(notes)); e != nil {
		return e
	}
	if !ftsDirty {
		return nil
	}
	if _, e := tx.Exec(`DELETE FROM tasks_fts WHERE id=?`, id); e != nil {
		return e
	}
	_, e := tx.Exec(`INSERT INTO tasks_fts(id,title) VALUES(?,?)`, id, asString(f["title"]))
	return e
}

// opAffectsFTS reports whether one op changes the searchable title or a task's
// existence — the only cases that require rewriting its FTS row. Notes are not
// indexed, so notes edits never touch FTS.
func opAffectsFTS(op Op) bool {
	return op.Type == "presence" || (op.Type == "field" && op.Field == "title")
}

func opsAffectFTS(ops []Op) bool {
	for _, op := range ops {
		if opAffectsFTS(op) {
			return true
		}
	}
	return false
}

func preview(s string) string {
	if len(s) > 120 {
		return s[:120]
	}
	return s
}

// ---- write API (per-entity, O(1)) ----

// TaskInput is the field set for creating/replacing a task. Empty Rank appends.
// Completion is `Status` (open/completed/canceled/trashed), matching the app; the
// legacy Completed bool is a convenience that maps to Status when Status is empty.
type TaskInput struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	ProjectID string   `json:"projectId"`
	When      string   `json:"when"`
	Deadline  string   `json:"deadline"`
	Priority  int      `json:"priority"`
	Completed bool     `json:"completed"`
	Status    string   `json:"status"`
	ParentID  string   `json:"parentId"`
	Order     float64  `json:"order"`
	Notes     string   `json:"notes"`
	Rank      string   `json:"rank"`
	Tags      []string `json:"tags"`
}

func (t TaskInput) status() string {
	if t.Status != "" {
		return t.Status
	}
	if t.Completed {
		return "completed"
	}
	return "open"
}

func (t TaskInput) fieldOps() []Op {
	ops := []Op{
		{Type: "presence", Kind: "task", ID: t.ID, Present: true},
		{Type: "field", Kind: "task", ID: t.ID, Field: "title", Value: canonAny(t.Title)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "projectId", Value: canonAny(t.ProjectID)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "when", Value: canonAny(t.When)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "deadline", Value: canonAny(t.Deadline)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "priority", Value: canonAny(t.Priority)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "status", Value: canonAny(t.status())},
		{Type: "field", Kind: "task", ID: t.ID, Field: "parentId", Value: canonAny(t.ParentID)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "order", Value: canonAny(t.Order)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "notes", Value: canonAny(t.Notes)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "rank", Value: canonAny(t.Rank)},
	}
	for _, tag := range t.Tags {
		ops = append(ops, Op{Type: "set", Kind: "task", ID: t.ID, Field: "tags", Elem: canonAny(tag), Present: true})
	}
	return ops
}

// CreateTask inserts one task. If Rank is empty it is appended after the current
// maximum. Returns the task id.
func (s *Store) CreateTask(t TaskInput) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.ID == "" {
		t.ID = "task-" + randID()
	}
	if t.Rank == "" {
		t.Rank = s.nextRank()
	}
	return t.ID, s.writeOps(t.fieldOps(), t.ID)
}

// Seed bulk-inserts many tasks in ONE transaction (append order). For tests and the
// load-test harness; ranks are assigned sequentially so no per-row MAX query.
func (s *Store) Seed(tasks []TaskInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	touched := map[string]bool{}
	for i := range tasks {
		t := tasks[i]
		if t.ID == "" {
			t.ID = fmt.Sprintf("task-%s-%d", randID(), i)
		}
		if t.Rank == "" {
			t.Rank = s.nextRank()
		}
		for _, op := range t.fieldOps() {
			op.HLC = s.clk.local()
			if _, err := applyOpTx(tx, op, true); err != nil {
				return err
			}
		}
		touched[t.ID] = true
	}
	for id := range touched {
		if err := reprojectTaskTx(tx, id, true); err != nil { // seed populates FTS
			return err
		}
	}
	if err := s.saveClockTx(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// BulkLoad imports many tasks fast: direct batched inserts into the CRDT tables +
// read-model, WITHOUT the per-op read/merge or oplog. It is an IMPORT/initial-seed
// path (e.g. hydrating from a server's full state), not a sync-write path — imported
// rows are authoritative locally and do not queue for push. Commits every `batch`
// rows so no single transaction grows unbounded. Empty ranks are appended.
func (s *Store) BulkLoad(tasks []TaskInput, batch int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if batch <= 0 {
		batch = 20000
	}
	for start := 0; start < len(tasks); start += batch {
		end := min(start+batch, len(tasks))
		if err := s.bulkBatch(tasks[start:end]); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) bulkBatch(tasks []TaskInput) (err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback() //nolint:errcheck
		}
	}()

	fStmt, err := tx.Prepare(`INSERT OR REPLACE INTO fields(kind,id,field,value,hlc) VALUES('task',?,?,?,?)`)
	if err != nil {
		return err
	}
	defer fStmt.Close()
	pStmt, err := tx.Prepare(`INSERT OR REPLACE INTO presence(kind,id,present,hlc) VALUES('task',?,1,?)`)
	if err != nil {
		return err
	}
	defer pStmt.Close()
	tStmt, err := tx.Prepare(`INSERT OR REPLACE INTO tasks(id,title,projectId,whenDate,deadline,priority,completed,status,parentId,ord,rank,notesPreview)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer tStmt.Close()
	ftsStmt, err := tx.Prepare(`INSERT INTO tasks_fts(id,title) VALUES(?,?)`)
	if err != nil {
		return err
	}
	defer ftsStmt.Close()

	for i := range tasks {
		t := tasks[i]
		if t.ID == "" {
			t.ID = "task-" + randID()
		}
		if t.Rank == "" {
			t.Rank = s.nextRank()
		}
		h := s.clk.local().String()
		scalars := [][2]string{
			{"title", canonAny(t.Title)}, {"projectId", canonAny(t.ProjectID)},
			{"when", canonAny(t.When)}, {"deadline", canonAny(t.Deadline)},
			{"priority", canonAny(t.Priority)}, {"completed", canonAny(t.Completed)},
			{"status", canonAny(t.status())}, {"parentId", canonAny(t.ParentID)},
			{"order", canonAny(t.Order)},
			{"notes", canonAny(t.Notes)}, {"rank", canonAny(t.Rank)},
		}
		if _, err = pStmt.Exec(t.ID, h); err != nil {
			return err
		}
		for _, kv := range scalars {
			if _, err = fStmt.Exec(t.ID, kv[0], kv[1], h); err != nil {
				return err
			}
		}
		for _, tag := range t.Tags {
			if _, err = tx.Exec(`INSERT OR REPLACE INTO setelems(kind,id,field,elem,present,hlc) VALUES('task',?,'tags',?,1,?)`,
				t.ID, canonAny(tag), h); err != nil {
				return err
			}
		}
		st := t.status()
		if _, err = tStmt.Exec(t.ID, t.Title, t.ProjectID, t.When, t.Deadline, t.Priority, b2i(st == "completed"), st, t.ParentID, t.Order, t.Rank, preview(t.Notes)); err != nil {
			return err
		}
		if _, err = ftsStmt.Exec(t.ID, t.Title); err != nil {
			return err
		}
	}
	if err = s.saveClockTx(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// Checkpoint flushes the WAL into the main database (TRUNCATE), reclaiming WAL
// space. Call after a large BulkLoad import to bound disk use and get an accurate
// on-disk size.
func (s *Store) Checkpoint() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	return err
}

// SetTaskField sets one scalar field (title, when, priority, …).
func (s *Store) SetTaskField(id, field string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeOps([]Op{{Type: "field", Kind: "task", ID: id, Field: field, Value: canonAny(value)}}, id)
}

// ToggleComplete sets a task's completion state. Completion is `status` (the app's
// model), so this sets status=completed|open, not a separate flag.
func (s *Store) ToggleComplete(id string, completed bool) error {
	st := "open"
	if completed {
		st = "completed"
	}
	return s.SetTaskField(id, "status", st)
}

// SetStatus sets the task's status (open/completed/canceled/trashed).
func (s *Store) SetStatus(id, status string) error {
	return s.SetTaskField(id, "status", status)
}

// MoveTask repositions a task between beforeID and afterID (either may be "" for
// list start/end), assigning a fractional rank strictly between their ranks.
func (s *Store) MoveTask(id, beforeID, afterID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, _ := s.rankOf(beforeID)
	next, _ := s.rankOf(afterID)
	rank := RankBetween(prev, next)
	return s.writeOps([]Op{{Type: "field", Kind: "task", ID: id, Field: "rank", Value: canonAny(rank)}}, id)
}

// AddTag / RemoveTag mutate a task's add-wins tag set.
func (s *Store) AddTag(id, tag string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeOps([]Op{{Type: "set", Kind: "task", ID: id, Field: "tags", Elem: canonAny(tag), Present: true}}, id)
}
func (s *Store) RemoveTag(id, tag string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeOps([]Op{{Type: "set", Kind: "task", ID: id, Field: "tags", Elem: canonAny(tag), Present: false}}, id)
}

// DeleteTask tombstones a task.
func (s *Store) DeleteTask(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeOps([]Op{{Type: "presence", Kind: "task", ID: id, Present: false}}, id)
}

// writeOps stamps + applies local ops in one tx and reprojects the task. Caller
// holds s.mu.
func (s *Store) writeOps(ops []Op, taskID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	for i := range ops {
		ops[i].HLC = s.clk.local()
		if _, err := applyOpTx(tx, ops[i], true); err != nil {
			return err
		}
	}
	if taskID != "" {
		if err := reprojectTaskTx(tx, taskID, opsAffectFTS(ops)); err != nil {
			return err
		}
	}
	if err := s.saveClockTx(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) rankOf(id string) (string, error) {
	if id == "" {
		return "", nil
	}
	var r string
	err := s.db.QueryRow(`SELECT rank FROM tasks WHERE id=?`, id).Scan(&r)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return r, err
}

// ---- read API (queries, not materializations) ----

// Cond is one structured filter: Field OP Values, e.g. {"priority",">=",[2]} or
// {"projectId","in",["p1","p2"]}. These are the operator filters for every field
// EXCEPT the title (which uses FTS via SearchTasks). Values are compared as indexed
// SQL, never full-text.
type Cond struct {
	Field  string `json:"field"`
	Op     string `json:"op"`
	Values []any  `json:"values"`
}

// filterColumns whitelists which fields can be filtered and maps them to their
// read-model column. A whitelist (not string interpolation) keeps the SQL
// injection-safe — an unknown field is an error, never concatenated in.
var filterColumns = map[string]string{
	"projectId": "projectId",
	"priority":  "priority",
	"when":      "whenDate",
	"deadline":  "deadline",
	"completed": "completed",
	"rank":      "rank",
}

var scalarOps = map[string]bool{"=": true, "!=": true, "<>": true, ">": true, "<": true, ">=": true, "<=": true}

// Query is a filter over the tasks read-model. The convenience fields cover the
// common cases; Conditions expresses the full operator set.
type Query struct {
	ProjectID    string `json:"projectId"`    // shorthand for {"projectId","=",...}
	When         string `json:"when"`         // shorthand for {"when","=",...}
	OnlyOpen     bool   `json:"onlyOpen"`     // completed = 0
	OnlyComplete bool   `json:"onlyComplete"` // completed = 1
	Conditions   []Cond `json:"conditions"`   // =, !=, <>, >, <, >=, <=, in, not in
	Limit        int    `json:"limit"`
	Offset       int    `json:"offset"`
}

// TaskRow is a list-view row (the columns a list actually renders).
type TaskRow struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	ProjectID string `json:"projectId"`
	When      string `json:"when"`
	Deadline  string `json:"deadline"`
	Priority  int    `json:"priority"`
	Completed bool   `json:"completed"`
	Rank      string `json:"rank"`
}

func normVal(v any) any {
	if b, ok := v.(bool); ok {
		return b2i(b) // completed etc. are stored as 0/1
	}
	return v
}

// where builds the parameterised WHERE clause. alias ("" or "t.") qualifies the
// columns so the same builder works for a plain query and the FTS join.
func (q Query) where(alias string) (string, []any, error) {
	var parts []string
	var args []any
	col := func(name string) string { return alias + name }

	if q.ProjectID != "" {
		parts = append(parts, col("projectId")+"=?")
		args = append(args, q.ProjectID)
	}
	if q.When != "" {
		parts = append(parts, col("whenDate")+"=?")
		args = append(args, q.When)
	}
	if q.OnlyOpen {
		parts = append(parts, col("completed")+"=0")
	}
	if q.OnlyComplete {
		parts = append(parts, col("completed")+"=1")
	}

	for _, c := range q.Conditions {
		column, ok := filterColumns[c.Field]
		if !ok {
			return "", nil, fmt.Errorf("record: unknown filter field %q", c.Field)
		}
		op := strings.ToLower(strings.TrimSpace(c.Op))
		switch op {
		case "in", "not in":
			if len(c.Values) == 0 {
				if op == "in" {
					parts = append(parts, "0=1") // IN () matches nothing; NOT IN () matches all
				}
				continue
			}
			ph := strings.TrimSuffix(strings.Repeat("?,", len(c.Values)), ",")
			kw := "IN"
			if op == "not in" {
				kw = "NOT IN"
			}
			parts = append(parts, col(column)+" "+kw+" ("+ph+")")
			for _, v := range c.Values {
				args = append(args, normVal(v))
			}
		default:
			if !scalarOps[op] {
				return "", nil, fmt.Errorf("record: unsupported operator %q", c.Op)
			}
			if len(c.Values) != 1 {
				return "", nil, fmt.Errorf("record: operator %q needs exactly one value", c.Op)
			}
			parts = append(parts, col(column)+" "+op+" ?")
			args = append(args, normVal(c.Values[0]))
		}
	}
	if len(parts) == 0 {
		return "", args, nil
	}
	return " WHERE " + strings.Join(parts, " AND "), args, nil
}

// QueryTasks returns a paged, rank-ordered slice of rows matching q. Memory is
// bounded by Limit, never the dataset.
func (s *Store) QueryTasks(q Query) ([]TaskRow, error) {
	where, args, err := q.where("")
	if err != nil {
		return nil, err
	}
	sqlStr := `SELECT id,title,projectId,whenDate,deadline,priority,completed,rank FROM tasks` + where + ` ORDER BY rank, id`
	if q.Limit > 0 {
		sqlStr += fmt.Sprintf(" LIMIT %d OFFSET %d", q.Limit, q.Offset)
	}
	return s.scanRows(sqlStr, args)
}

// SearchTasks runs an offline FTS5 word-prefix query over the task TITLE only,
// intersected with q's structured (operator) filters, rank-ordered and paged.
func (s *Store) SearchTasks(text string, q Query) ([]TaskRow, error) {
	where, args, err := q.where("t.")
	if err != nil {
		return nil, err
	}
	full := `SELECT t.id,t.title,t.projectId,t.whenDate,t.deadline,t.priority,t.completed,t.rank
	         FROM tasks t JOIN (SELECT id FROM tasks_fts WHERE tasks_fts MATCH ?) m ON m.id=t.id` +
		where + ` ORDER BY t.rank, t.id`
	if q.Limit > 0 {
		full += fmt.Sprintf(" LIMIT %d OFFSET %d", q.Limit, q.Offset)
	}
	return s.scanRows(full, append([]any{ftsQuery(text)}, args...))
}

// QueryList runs a smart-list query in SQL (mirrors src/store/selectors.js and the
// web adapter's queryList). Currently supports "today"; other lists return an error
// so the caller falls back to its in-memory selector until they're ported.
func (s *Store) QueryList(listID, todayKey string) ([]TaskRow, error) {
	if listID != "today" {
		return nil, fmt.Errorf("record: queryList unsupported list %q", listID)
	}
	// Today = open, top-level, and due today/evening OR a concrete date/deadline
	// on-or-before today; ordered by the app's numeric order.
	return s.scanRows(`SELECT id,title,projectId,whenDate,deadline,priority,completed,rank FROM tasks
		WHERE status='open' AND (parentId IS NULL OR parentId='')
		  AND ( whenDate IN ('today','evening')
		        OR (whenDate LIKE '____-__-__' AND whenDate <= ?)
		        OR (deadline LIKE '____-__-__' AND deadline <= ?) )
		ORDER BY ord, id`, []any{todayKey, todayKey})
}

// CountTasks returns the number of matching tasks via an indexed COUNT (never loads
// rows) — for view badges.
func (s *Store) CountTasks(q Query) (int, error) {
	where, args, err := q.where("")
	if err != nil {
		return 0, err
	}
	var n int
	err = s.db.QueryRow(`SELECT COUNT(*) FROM tasks`+where, args...).Scan(&n)
	return n, err
}

// GetTask returns the FULL task object (all fields, incl. non-columnar ones like
// checklist) from the CRDT source of truth — for the detail view.
func (s *Store) GetTask(id string) (map[string]any, error) {
	var present int
	err := s.db.QueryRow(`SELECT present FROM presence WHERE kind='task' AND id=?`, id).Scan(&present)
	if err == sql.ErrNoRows || (err == nil && present == 0) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	obj := map[string]any{"id": id}
	rows, err := s.db.Query(`SELECT field,value FROM fields WHERE kind='task' AND id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var field, value string
		if err := rows.Scan(&field, &value); err != nil {
			return nil, err
		}
		var v any
		if json.Unmarshal([]byte(value), &v) == nil {
			obj[field] = v
		}
	}
	// tags (add-wins set)
	tagRows, err := s.db.Query(`SELECT elem FROM setelems WHERE kind='task' AND id=? AND field='tags' AND present=1`, id)
	if err != nil {
		return nil, err
	}
	defer tagRows.Close()
	var tags []any
	for tagRows.Next() {
		var elem string
		if err := tagRows.Scan(&elem); err != nil {
			return nil, err
		}
		tags = append(tags, asString(elem))
	}
	obj["tags"] = tags
	return obj, nil
}

func (s *Store) scanRows(sqlStr string, args []any) ([]TaskRow, error) {
	rows, err := s.db.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TaskRow
	for rows.Next() {
		var r TaskRow
		var completed int
		if err := rows.Scan(&r.ID, &r.Title, &r.ProjectID, &r.When, &r.Deadline, &r.Priority, &completed, &r.Rank); err != nil {
			return nil, err
		}
		r.Completed = completed == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// ftsQuery turns free text into a safe FTS5 prefix query (each token quoted, prefix
// match) so arbitrary user input can't break the MATCH syntax.
func ftsQuery(text string) string {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return "\"\""
	}
	parts := make([]string, 0, len(fields))
	for _, f := range fields {
		f = strings.ReplaceAll(f, "\"", "")
		if f == "" {
			continue
		}
		parts = append(parts, "\""+f+"\"*")
	}
	return strings.Join(parts, " ")
}

// ---- sync (op-log push/pull) ----

// PendingOps returns up to limit unsynced local ops (oldest first) with their seq
// numbers, for pushing to the server. Peek semantics: they stay until MarkSynced.
func (s *Store) PendingOps(limit int) ([]SeqOp, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 {
		limit = 500
	}
	rows, err := s.db.Query(`SELECT seq,optype,kind,id,field,elem,value,present,hlc
		FROM oplog WHERE synced=0 ORDER BY seq LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeqOp
	for rows.Next() {
		var so SeqOp
		var present int
		var hlc string
		if err := rows.Scan(&so.Seq, &so.Op.Type, &so.Op.Kind, &so.Op.ID, &so.Op.Field, &so.Op.Elem, &so.Op.Value, &present, &hlc); err != nil {
			return nil, err
		}
		so.Op.Present = present == 1
		so.Op.HLC = parseHLC(hlc)
		out = append(out, so)
	}
	return out, rows.Err()
}

// MarkSynced flips the given oplog seqs to synced (called after a successful push).
func (s *Store) MarkSynced(seqs []int64) error {
	if len(seqs) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	for _, seq := range seqs {
		if _, err := tx.Exec(`UPDATE oplog SET synced=1 WHERE seq=?`, seq); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ApplyRemote merges pulled ops (LWW), witnesses their clocks, and reprojects every
// task they touched. Idempotent and commutative — the CRDT property. Remote ops are
// NOT logged for re-push.
func (s *Store) ApplyRemote(ops []Op) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()          //nolint:errcheck
	touched := map[string]bool{} // task id -> ftsDirty
	for _, op := range ops {
		s.clk.witness(op.HLC)
		if op.Node() == s.node {
			continue // our own echo
		}
		applied, err := applyOpTx(tx, op, false)
		if err != nil {
			return err
		}
		if applied && op.Kind == "task" {
			touched[op.ID] = touched[op.ID] || opAffectsFTS(op)
		}
	}
	for id, ftsDirty := range touched {
		if err := reprojectTaskTx(tx, id, ftsDirty); err != nil {
			return err
		}
	}
	if err := s.saveClockTx(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// SeqOp is a pending op paired with its oplog sequence number.
type SeqOp struct {
	Seq int64 `json:"seq"`
	Op  Op    `json:"op"`
}

// ---- identity + clock persistence ----

func (s *Store) ensureNode() string {
	var v string
	if err := s.db.QueryRow(`SELECT value FROM meta WHERE key='node'`).Scan(&v); err == nil && v != "" {
		return v
	}
	v = "dev-" + randID()
	_, _ = s.db.Exec(`INSERT OR REPLACE INTO meta(key,value) VALUES('node',?)`, v)
	return v
}

func (s *Store) loadClock() HLC {
	var v string
	if err := s.db.QueryRow(`SELECT value FROM meta WHERE key='hlc'`).Scan(&v); err == nil {
		return parseHLC(v)
	}
	return HLC{}
}

func (s *Store) saveClockTx(tx *sql.Tx) error {
	if _, err := tx.Exec(`INSERT OR REPLACE INTO meta(key,value) VALUES('hlc',?)`, s.clk.current().String()); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT OR REPLACE INTO meta(key,value) VALUES('rankctr',?)`, strconv.FormatUint(s.rankCtr, 10))
	return err
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func randID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}
