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
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver (no cgo → gomobile-friendly)
)

// Store owns the SQLite handle + HLC clock and serialises writes.
type Store struct {
	mu   sync.Mutex
	db   *sql.DB
	node string
	clk  *clock
	now  func() int64
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
	return s, nil
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

-- Derived read-model for tasks (rebuildable from fields/presence).
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  projectId TEXT NOT NULL DEFAULT '',
  whenDate TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  rank TEXT NOT NULL DEFAULT '',
  notesPreview TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(projectId, rank);
CREATE INDEX IF NOT EXISTS tasks_when ON tasks(whenDate) WHERE completed = 0;
CREATE INDEX IF NOT EXISTS tasks_completed ON tasks(completed, rank);

-- Full-text search over title + notes (offline). id UNINDEXED lets us map hits
-- back to a task and re-sync a single row.
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(id UNINDEXED, title, notes);
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

// reprojectTaskTx rebuilds the tasks + tasks_fts read-model rows for one task from
// the CRDT source of truth. Called after every write that touches a task.
func reprojectTaskTx(tx *sql.Tx, id string) error {
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
	if _, e := tx.Exec(`INSERT INTO tasks(id,title,projectId,whenDate,deadline,priority,completed,rank,notesPreview)
		VALUES(?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET title=excluded.title, projectId=excluded.projectId,
		  whenDate=excluded.whenDate, deadline=excluded.deadline, priority=excluded.priority,
		  completed=excluded.completed, rank=excluded.rank, notesPreview=excluded.notesPreview`,
		id, asString(f["title"]), asString(f["projectId"]), asString(f["when"]),
		asString(f["deadline"]), asInt(f["priority"]), b2i(asBool(f["completed"])),
		asString(f["rank"]), preview(notes)); e != nil {
		return e
	}
	if _, e := tx.Exec(`DELETE FROM tasks_fts WHERE id=?`, id); e != nil {
		return e
	}
	_, e := tx.Exec(`INSERT INTO tasks_fts(id,title,notes) VALUES(?,?,?)`, id, asString(f["title"]), notes)
	return e
}

func preview(s string) string {
	if len(s) > 120 {
		return s[:120]
	}
	return s
}

// ---- write API (per-entity, O(1)) ----

// TaskInput is the field set for creating/replacing a task. Empty Rank appends.
type TaskInput struct {
	ID        string
	Title     string
	ProjectID string
	When      string
	Deadline  string
	Priority  int
	Completed bool
	Notes     string
	Rank      string
	Tags      []string
}

func (t TaskInput) fieldOps() []Op {
	ops := []Op{
		{Type: "presence", Kind: "task", ID: t.ID, Present: true},
		{Type: "field", Kind: "task", ID: t.ID, Field: "title", Value: canonAny(t.Title)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "projectId", Value: canonAny(t.ProjectID)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "when", Value: canonAny(t.When)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "deadline", Value: canonAny(t.Deadline)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "priority", Value: canonAny(t.Priority)},
		{Type: "field", Kind: "task", ID: t.ID, Field: "completed", Value: canonAny(t.Completed)},
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
		var maxRank string
		_ = s.db.QueryRow(`SELECT COALESCE(MAX(rank),'') FROM tasks`).Scan(&maxRank)
		t.Rank = RankAfter(maxRank)
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

	var lastRank string
	_ = tx.QueryRow(`SELECT COALESCE(MAX(rank),'') FROM tasks`).Scan(&lastRank)
	touched := map[string]bool{}
	for i := range tasks {
		t := tasks[i]
		if t.ID == "" {
			t.ID = fmt.Sprintf("task-%s-%d", randID(), i)
		}
		if t.Rank == "" {
			lastRank = RankAfter(lastRank)
			t.Rank = lastRank
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
		if err := reprojectTaskTx(tx, id); err != nil {
			return err
		}
	}
	if err := s.saveClockTx(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// SetTaskField sets one scalar field (title, when, priority, …).
func (s *Store) SetTaskField(id, field string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeOps([]Op{{Type: "field", Kind: "task", ID: id, Field: field, Value: canonAny(value)}}, id)
}

// ToggleComplete sets a task's completion state.
func (s *Store) ToggleComplete(id string, completed bool) error {
	return s.SetTaskField(id, "completed", completed)
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
		if err := reprojectTaskTx(tx, taskID); err != nil {
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

// Query is a filter over the tasks read-model. Zero values mean "no constraint".
type Query struct {
	ProjectID    string
	When         string
	OnlyOpen     bool // completed = 0
	OnlyComplete bool // completed = 1
	Limit        int
	Offset       int
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

func (q Query) where() (string, []any) {
	var conds []string
	var args []any
	if q.ProjectID != "" {
		conds = append(conds, "projectId=?")
		args = append(args, q.ProjectID)
	}
	if q.When != "" {
		conds = append(conds, "whenDate=?")
		args = append(args, q.When)
	}
	if q.OnlyOpen {
		conds = append(conds, "completed=0")
	}
	if q.OnlyComplete {
		conds = append(conds, "completed=1")
	}
	if len(conds) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

// QueryTasks returns a paged, rank-ordered slice of rows matching q. Memory is
// bounded by Limit, never the dataset.
func (s *Store) QueryTasks(q Query) ([]TaskRow, error) {
	where, args := q.where()
	sqlStr := `SELECT id,title,projectId,whenDate,deadline,priority,completed,rank FROM tasks` + where + ` ORDER BY rank`
	if q.Limit > 0 {
		sqlStr += fmt.Sprintf(" LIMIT %d OFFSET %d", q.Limit, q.Offset)
	}
	return s.scanRows(sqlStr, args)
}

// SearchTasks runs an offline FTS5 full-text query over title+notes, intersected
// with q's structured filters, rank-ordered and paged.
func (s *Store) SearchTasks(text string, q Query) ([]TaskRow, error) {
	where, args := q.where()
	// tasks_fts MATCH gives ids; join back to the read-model for columns + filters.
	inner := `SELECT id FROM tasks_fts WHERE tasks_fts MATCH ?`
	full := `SELECT t.id,t.title,t.projectId,t.whenDate,t.deadline,t.priority,t.completed,t.rank
	         FROM tasks t JOIN (` + inner + `) m ON m.id=t.id` + where + ` ORDER BY t.rank`
	if q.Limit > 0 {
		full += fmt.Sprintf(" LIMIT %d OFFSET %d", q.Limit, q.Offset)
	}
	// re-qualify WHERE column names to the t. alias
	full = strings.Replace(full, " WHERE projectId", " WHERE t.projectId", 1)
	full = strings.NewReplacer("WHERE completed", "WHERE t.completed", "AND completed", "AND t.completed",
		"WHERE whenDate", "WHERE t.whenDate", "AND whenDate", "AND t.whenDate",
		"AND projectId", "AND t.projectId").Replace(full)
	return s.scanRows(full, append([]any{ftsQuery(text)}, args...))
}

// CountTasks returns the number of matching tasks via an indexed COUNT (never loads
// rows) — for view badges.
func (s *Store) CountTasks(q Query) (int, error) {
	where, args := q.where()
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM tasks`+where, args...).Scan(&n)
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
	defer tx.Rollback() //nolint:errcheck
	touched := map[string]bool{}
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
			touched[op.ID] = true
		}
	}
	for id := range touched {
		if err := reprojectTaskTx(tx, id); err != nil {
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
	_, err := tx.Exec(`INSERT OR REPLACE INTO meta(key,value) VALUES('hlc',?)`, s.clk.current().String())
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
