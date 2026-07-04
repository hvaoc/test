// Package core is the app's offline-first data engine: an embedded SQLite
// database plus a change-log (oplog) that powers cloud sync. It is deliberately
// UI- and platform-agnostic so the SAME code backs the Wails desktop build and
// the gomobile-bound iOS / Android apps (see ../mobile). The frontend keeps its
// rich in-memory model and hands the store whole-state snapshots; the store
// decomposes them into per-entity rows, diffs against what it already holds, and
// records an oplog entry for every change so sync only ever ships deltas.
package core

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver (no cgo → gomobile-friendly)
)

// The entity kinds a snapshot decomposes into. Order matters only for
// deterministic reassembly.
var entityKinds = []string{"area", "project", "heading", "task", "tag", "customView"}

// Store owns the SQLite handle and serializes access (SQLite + our diff logic
// aren't safe under concurrent writers).
type Store struct {
	mu      sync.Mutex
	db      *sql.DB
	device  string
	adapter SyncAdapter  // cloud sync seam; nil = sync disabled
	now     func() int64 // injectable clock (ms); real one by default
}

// Open creates/opens the database under dir (created if missing) and applies the
// schema. dir is a per-user writable directory (App Support on macOS/iOS, the
// app's files dir on Android).
func Open(dir string) (*Store, error) {
	path := filepath.Join(dir, "playdata.db")
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one writer; keeps the diff/apply logic race-free
	s := &Store{db: db, now: func() int64 { return time.Now().UnixMilli() }}
	if err := s.migrate(); err != nil {
		return nil, err
	}
	s.device = s.ensureDeviceID()
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS entities (
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,       -- the entity as JSON
  updated_at INTEGER NOT NULL,    -- last-writer-wins clock (ms)
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, id)
);

-- One row per local mutation, awaiting push to the cloud. Remote mutations that
-- have been applied locally are NOT recorded here (origin='remote' is skipped).
CREATE TABLE IF NOT EXISTS oplog (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL,
  device     TEXT NOT NULL,
  synced     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS oplog_unsynced ON oplog(synced) WHERE synced = 0;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)
	return err
}

// ---------------------------------------------------------------------------
// Snapshot round-trip. The frontend state is a JSON object:
//   { areas, projects, headings, tasks, customViews: [ {id,...} ],
//     tags: ["Design", ...], settings: { ... } }
// ---------------------------------------------------------------------------

type snapshot struct {
	Areas       []json.RawMessage `json:"areas"`
	Projects    []json.RawMessage `json:"projects"`
	Headings    []json.RawMessage `json:"headings"`
	Tasks       []json.RawMessage `json:"tasks"`
	CustomViews []json.RawMessage `json:"customViews"`
	Tags        []string          `json:"tags"`
	Settings    json.RawMessage   `json:"settings"`
}

func (s *snapshot) collections() map[string][]json.RawMessage {
	return map[string][]json.RawMessage{
		"area":       s.Areas,
		"project":    s.Projects,
		"heading":    s.Headings,
		"task":       s.Tasks,
		"customView": s.CustomViews,
	}
}

// idOf pulls the "id" field out of an entity's JSON.
func idOf(raw json.RawMessage) (string, bool) {
	var probe struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.ID == "" {
		return "", false
	}
	return probe.ID, true
}

// SaveSnapshot decomposes the full frontend state into entity rows, diffs each
// against the stored copy, and records an oplog entry for every insert / update
// / delete. Tags (bare strings) and settings (a singleton object) are stored as
// their own kinds. Unchanged entities cost nothing.
func (s *Store) SaveSnapshot(stateJSON string) error {
	var snap snapshot
	if err := json.Unmarshal([]byte(stateJSON), &snap); err != nil {
		return fmt.Errorf("parse snapshot: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	// Regular id-bearing collections.
	for kind, items := range snap.collections() {
		present := make(map[string]struct{}, len(items))
		for _, raw := range items {
			id, ok := idOf(raw)
			if !ok {
				continue
			}
			present[id] = struct{}{}
			if err := s.upsertTx(tx, kind, id, string(raw), false); err != nil {
				return err
			}
		}
		if err := s.deleteMissingTx(tx, kind, present); err != nil {
			return err
		}
	}

	// Tags: bare strings; id == the tag text.
	tagPresent := make(map[string]struct{}, len(snap.Tags))
	for _, name := range snap.Tags {
		tagPresent[name] = struct{}{}
		data, _ := json.Marshal(map[string]string{"name": name})
		if err := s.upsertTx(tx, "tag", name, string(data), false); err != nil {
			return err
		}
	}
	if err := s.deleteMissingTx(tx, "tag", tagPresent); err != nil {
		return err
	}

	// Settings singleton.
	if len(snap.Settings) > 0 {
		if err := s.upsertTx(tx, "setting", "app", string(snap.Settings), false); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// upsertTx writes an entity only when its JSON actually changed, and records the
// change in the oplog so sync can ship it. Returns nil (no-op) when unchanged.
func (s *Store) upsertTx(tx *sql.Tx, kind, id, data string, deleted bool) error {
	var curData string
	var curDeleted int
	row := tx.QueryRow(`SELECT data, deleted FROM entities WHERE kind=? AND id=?`, kind, id)
	err := row.Scan(&curData, &curDeleted)
	switch {
	case err == sql.ErrNoRows:
		// new entity
	case err != nil:
		return err
	default:
		delFlag := 0
		if deleted {
			delFlag = 1
		}
		if curData == data && curDeleted == delFlag {
			return nil // genuinely unchanged
		}
	}

	ts := s.now()
	delInt := 0
	if deleted {
		delInt = 1
	}
	if _, err := tx.Exec(
		`INSERT INTO entities(kind,id,data,updated_at,deleted) VALUES(?,?,?,?,?)
		 ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, deleted=excluded.deleted`,
		kind, id, data, ts, delInt,
	); err != nil {
		return err
	}
	_, err = tx.Exec(
		`INSERT INTO oplog(kind,id,data,updated_at,deleted,device,synced) VALUES(?,?,?,?,?,?,0)`,
		kind, id, data, ts, delInt, s.device,
	)
	return err
}

// deleteMissingTx soft-deletes stored entities of a kind that are absent from
// the latest snapshot (the user removed them), recording each in the oplog.
func (s *Store) deleteMissingTx(tx *sql.Tx, kind string, present map[string]struct{}) error {
	rows, err := tx.Query(`SELECT id, data FROM entities WHERE kind=? AND deleted=0`, kind)
	if err != nil {
		return err
	}
	var gone []struct{ id, data string }
	for rows.Next() {
		var id, data string
		if err := rows.Scan(&id, &data); err != nil {
			rows.Close()
			return err
		}
		if _, ok := present[id]; !ok {
			gone = append(gone, struct{ id, data string }{id, data})
		}
	}
	rows.Close()
	for _, g := range gone {
		if err := s.upsertTx(tx, kind, g.id, g.data, true); err != nil {
			return err
		}
	}
	return nil
}

// LoadSnapshot reassembles the frontend state JSON from the non-deleted
// entities. Returns an empty snapshot (not an error) for a fresh database, so
// the caller can fall back to its seed data.
func (s *Store) LoadSnapshot() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := map[string]interface{}{}
	for _, kind := range entityKinds {
		key := pluralOf(kind)
		if kind == "tag" {
			continue
		}
		items, err := s.collect(kind)
		if err != nil {
			return "", err
		}
		out[key] = items
	}

	// Tags → array of names.
	tagRows, err := s.collect("tag")
	if err != nil {
		return "", err
	}
	tags := make([]string, 0, len(tagRows))
	for _, t := range tagRows {
		if m, ok := t.(map[string]interface{}); ok {
			if name, ok := m["name"].(string); ok {
				tags = append(tags, name)
			}
		}
	}
	out["tags"] = tags

	// Settings singleton.
	if raw, ok, err := s.getEntity("setting", "app"); err != nil {
		return "", err
	} else if ok {
		var settings interface{}
		if err := json.Unmarshal([]byte(raw), &settings); err == nil {
			out["settings"] = settings
		}
	}

	b, err := json.Marshal(out)
	return string(b), err
}

// HasData reports whether the DB already holds any live entity (used to decide
// snapshot-vs-seed on startup).
func (s *Store) HasData() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM entities WHERE deleted=0`).Scan(&n)
	return n > 0, err
}

func (s *Store) collect(kind string) ([]interface{}, error) {
	rows, err := s.db.Query(`SELECT data FROM entities WHERE kind=? AND deleted=0`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []interface{}{}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var v interface{}
		if err := json.Unmarshal([]byte(data), &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) getEntity(kind, id string) (string, bool, error) {
	var data string
	var deleted int
	err := s.db.QueryRow(`SELECT data, deleted FROM entities WHERE kind=? AND id=?`, kind, id).Scan(&data, &deleted)
	if err == sql.ErrNoRows || (err == nil && deleted == 1) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return data, true, nil
}

func (s *Store) ensureDeviceID() string {
	var v string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key='device_id'`).Scan(&v)
	if err == nil && v != "" {
		return v
	}
	v = fmt.Sprintf("dev-%d", s.now())
	_, _ = s.db.Exec(`INSERT OR REPLACE INTO meta(key,value) VALUES('device_id',?)`, v)
	return v
}

func pluralOf(kind string) string {
	switch kind {
	case "area":
		return "areas"
	case "project":
		return "projects"
	case "heading":
		return "headings"
	case "task":
		return "tasks"
	case "customView":
		return "customViews"
	case "tag":
		return "tags"
	default:
		return kind + "s"
	}
}
