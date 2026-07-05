// Package core is the app's offline-first data engine: an embedded SQLite
// database plus a field-level CRDT that makes cloud sync automatically
// conflict-free. It is deliberately UI- and platform-agnostic so the SAME code
// backs the Wails desktop build and the gomobile-bound iOS / Android apps (see
// ../mobile).
//
// # Conflict model
//
// Every entity (task, project, area, …) is stored NOT as one opaque blob but as
// a set of independently-versioned registers:
//
//   - Each scalar field (title, when, deadline, priority, order, notes, the
//     whole `query` object, the whole `checklist` array, …) is a Last-Writer-
//     Wins register stamped with a Hybrid Logical Clock (see hlc.go). Two
//     devices editing DIFFERENT fields of the same task both keep their change;
//     editing the SAME field resolves to the higher HLC — deterministically, on
//     every replica.
//   - Set-valued fields (a task's `tags`) are an add-wins LWW-element-set, so
//     concurrent tag additions on different devices all survive.
//   - Entity existence is its own LWW register (a tombstone), so create/delete
//     races resolve deterministically too.
//
// The frontend never sees any of this: it keeps its rich in-memory model and
// hands the engine whole-state snapshots. SaveSnapshot diffs a snapshot into
// per-field CRDT operations; LoadSnapshot materialises the merged state back.
package core

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver (no cgo → gomobile-friendly)
)

// Kinds with id-bearing object collections in the snapshot.
var objectKinds = []string{"area", "project", "heading", "task", "customView"}

// Fields that are SETS (CRDT add-wins element sets) rather than scalar LWW
// registers. Keyed by kind → field.
var setFields = map[string]map[string]bool{
	"task": {"tags": true},
}

func isSetField(kind, field string) bool { return setFields[kind] != nil && setFields[kind][field] }

// Store owns the SQLite handle + HLC clock and serialises access.
type Store struct {
	mu      sync.Mutex
	db      *sql.DB
	device  string
	clk     *clock
	adapter SyncAdapter  // cloud sync seam; nil = sync disabled
	now     func() int64 // injectable clock (ms)
}

// Open creates/opens the database under dir and applies the schema.
func Open(dir string) (*Store, error) {
	path := filepath.Join(dir, "playdata.db")
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer keeps the CRDT apply logic race-free
	s := &Store{db: db, now: func() int64 { return time.Now().UnixMilli() }}
	if err := s.migrate(); err != nil {
		return nil, err
	}
	s.device = s.ensureDeviceID()
	s.clk = newClock(s.device, func() int64 { return s.now() }, s.loadClock())
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
-- Scalar LWW registers: one row per (entity, field).
CREATE TABLE IF NOT EXISTS fields (
  kind  TEXT NOT NULL,
  id    TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,   -- canonical JSON of the field value
  hlc   TEXT NOT NULL,   -- "wall.ctr.node"
  PRIMARY KEY (kind, id, field)
);

-- Add-wins set CRDT: one row per (entity, field, element). present=1 means the
-- element is in the set; a remove flips it to 0 with a newer HLC.
CREATE TABLE IF NOT EXISTS setelems (
  kind    TEXT NOT NULL,
  id      TEXT NOT NULL,
  field   TEXT NOT NULL,
  elem    TEXT NOT NULL,  -- canonical JSON of the element
  present INTEGER NOT NULL,
  hlc     TEXT NOT NULL,
  PRIMARY KEY (kind, id, field, elem)
);

-- Entity existence as an LWW register (tombstone when present=0).
CREATE TABLE IF NOT EXISTS presence (
  kind    TEXT NOT NULL,
  id      TEXT NOT NULL,
  present INTEGER NOT NULL,
  hlc     TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);

-- Local, not-yet-pushed CRDT ops. Remote ops applied during merge are NOT
-- logged here (they must not echo back to the cloud).
CREATE TABLE IF NOT EXISTS oplog (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  optype  TEXT NOT NULL,          -- 'field' | 'set' | 'presence'
  kind    TEXT NOT NULL,
  id      TEXT NOT NULL,
  field   TEXT NOT NULL DEFAULT '',
  elem    TEXT NOT NULL DEFAULT '',
  value   TEXT NOT NULL DEFAULT '',
  present INTEGER NOT NULL DEFAULT 0,
  hlc     TEXT NOT NULL,
  synced  INTEGER NOT NULL DEFAULT 0
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
// Canonical JSON. Marshalling through interface{} sorts object keys, so two
// snapshots that differ only in key order don't look like a change (no spurious
// ops) and register comparisons are stable.
//
// CRITICAL: this must produce byte-identical output to the browser CRDT's
// canon() (src/store/crdt.js) for the same logical value, or a value written on
// one platform and read on another looks "changed" and the two replicas emit
// ops back and forth forever. That means HTML escaping OFF (Go escapes <>&  by
// default; JSON.stringify does not) and sorted object keys (both do this).
// ---------------------------------------------------------------------------

func canon(raw json.RawMessage) string {
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		return string(raw)
	}
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return string(raw)
	}
	return strings.TrimRight(buf.String(), "\n") // Encoder appends a newline
}

func ekey(kind, id string) string { return kind + "\x1f" + id }

// ---------------------------------------------------------------------------
// In-memory view of the current CRDT state, loaded once per operation so
// diff/merge work against maps instead of per-field point queries.
// ---------------------------------------------------------------------------

type fieldRow struct {
	value string
	hlc   HLC
}
type setRow struct {
	present bool
	hlc     HLC
}
type presRow struct {
	present bool
	hlc     HLC
}

type view struct {
	presence map[string]presRow                      // ekey -> presence
	fields   map[string]map[string]fieldRow          // ekey -> field -> reg
	sets     map[string]map[string]map[string]setRow // ekey -> field -> elem -> reg
}

func (s *Store) loadView(q queryer) (*view, error) {
	v := &view{
		presence: map[string]presRow{},
		fields:   map[string]map[string]fieldRow{},
		sets:     map[string]map[string]map[string]setRow{},
	}
	if rows, err := q.Query(`SELECT kind,id,present,hlc FROM presence`); err != nil {
		return nil, err
	} else {
		for rows.Next() {
			var kind, id, hlc string
			var pres int
			if err := rows.Scan(&kind, &id, &pres, &hlc); err != nil {
				rows.Close()
				return nil, err
			}
			v.presence[ekey(kind, id)] = presRow{present: pres == 1, hlc: parseHLC(hlc)}
		}
		rows.Close()
	}
	if rows, err := q.Query(`SELECT kind,id,field,value,hlc FROM fields`); err != nil {
		return nil, err
	} else {
		for rows.Next() {
			var kind, id, field, value, hlc string
			if err := rows.Scan(&kind, &id, &field, &value, &hlc); err != nil {
				rows.Close()
				return nil, err
			}
			k := ekey(kind, id)
			if v.fields[k] == nil {
				v.fields[k] = map[string]fieldRow{}
			}
			v.fields[k][field] = fieldRow{value: value, hlc: parseHLC(hlc)}
		}
		rows.Close()
	}
	if rows, err := q.Query(`SELECT kind,id,field,elem,present,hlc FROM setelems`); err != nil {
		return nil, err
	} else {
		for rows.Next() {
			var kind, id, field, elem, hlc string
			var pres int
			if err := rows.Scan(&kind, &id, &field, &elem, &pres, &hlc); err != nil {
				rows.Close()
				return nil, err
			}
			k := ekey(kind, id)
			if v.sets[k] == nil {
				v.sets[k] = map[string]map[string]setRow{}
			}
			if v.sets[k][field] == nil {
				v.sets[k][field] = map[string]setRow{}
			}
			v.sets[k][field][elem] = setRow{present: pres == 1, hlc: parseHLC(hlc)}
		}
		rows.Close()
	}
	return v, nil
}

// queryer is satisfied by both *sql.DB and *sql.Tx.
type queryer interface {
	Query(query string, args ...interface{}) (*sql.Rows, error)
}

// ---------------------------------------------------------------------------
// SaveSnapshot — diff the frontend snapshot into CRDT ops and apply them.
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

func (s *snapshot) collection(kind string) []json.RawMessage {
	switch kind {
	case "area":
		return s.Areas
	case "project":
		return s.Projects
	case "heading":
		return s.Headings
	case "task":
		return s.Tasks
	case "customView":
		return s.CustomViews
	}
	return nil
}

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

	cur, err := s.loadView(tx)
	if err != nil {
		return err
	}

	ops := s.diff(&snap, cur)
	for i := range ops {
		ops[i].setHLC(s.clk.local())
		if _, err := applyOpTx(tx, ops[i], true); err != nil {
			return err
		}
	}
	if err := s.saveClockTx(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// diff produces the CRDT ops needed to turn the stored state into the snapshot.
func (s *Store) diff(snap *snapshot, cur *view) []Op {
	var ops []Op

	emitEntity := func(kind, id string, fields map[string]json.RawMessage) {
		k := ekey(kind, id)
		// Presence: mark present if not already.
		if p, ok := cur.presence[k]; !ok || !p.present {
			ops = append(ops, Op{Type: "presence", Kind: kind, ID: id, Present: true})
		}
		for field, raw := range fields {
			if field == "id" {
				continue
			}
			if isSetField(kind, field) {
				ops = append(ops, s.diffSet(kind, id, field, raw, cur)...)
				continue
			}
			nv := canon(raw)
			if fr, ok := cur.fields[k][field]; !ok || fr.value != nv {
				ops = append(ops, Op{Type: "field", Kind: kind, ID: id, Field: field, Value: json.RawMessage(nv)})
			}
		}
	}

	seen := map[string]bool{} // ekey of entities present in this snapshot

	for _, kind := range objectKinds {
		for _, raw := range snap.collection(kind) {
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(raw, &fields); err != nil {
				continue
			}
			id := ""
			if raw, ok := fields["id"]; ok {
				_ = json.Unmarshal(raw, &id)
			}
			if id == "" {
				continue
			}
			seen[ekey(kind, id)] = true
			emitEntity(kind, id, fields)
		}
	}

	// Tags: bare-string entities (existence-only).
	for _, name := range snap.Tags {
		k := ekey("tag", name)
		seen[k] = true
		if p, ok := cur.presence[k]; !ok || !p.present {
			ops = append(ops, Op{Type: "presence", Kind: "tag", ID: name, Present: true})
		}
	}

	// Settings singleton → each key a scalar field of ('setting','app').
	if len(snap.Settings) > 0 {
		var settings map[string]json.RawMessage
		if err := json.Unmarshal(snap.Settings, &settings); err == nil {
			k := ekey("setting", "app")
			seen[k] = true
			if p, ok := cur.presence[k]; !ok || !p.present {
				ops = append(ops, Op{Type: "presence", Kind: "setting", ID: "app", Present: true})
			}
			for field, raw := range settings {
				nv := canon(raw)
				if fr, ok := cur.fields[k][field]; !ok || fr.value != nv {
					ops = append(ops, Op{Type: "field", Kind: "setting", ID: "app", Field: field, Value: json.RawMessage(nv)})
				}
			}
		}
	}

	// Tombstones: entities currently present but gone from the snapshot.
	for k, p := range cur.presence {
		if p.present && !seen[k] {
			parts := strings.SplitN(k, "\x1f", 2)
			ops = append(ops, Op{Type: "presence", Kind: parts[0], ID: parts[1], Present: false})
		}
	}
	return ops
}

// diffSet turns a scalar array field into add-wins set add/remove ops.
func (s *Store) diffSet(kind, id, field string, raw json.RawMessage, cur *view) []Op {
	var elems []json.RawMessage
	_ = json.Unmarshal(raw, &elems)
	want := map[string]bool{}
	for _, e := range elems {
		want[canon(e)] = true
	}
	var ops []Op
	k := ekey(kind, id)
	existing := cur.sets[k][field]
	for elem := range want {
		if r, ok := existing[elem]; !ok || !r.present {
			ops = append(ops, Op{Type: "set", Kind: kind, ID: id, Field: field, Elem: elem, Present: true})
		}
	}
	for elem, r := range existing {
		if r.present && !want[elem] {
			ops = append(ops, Op{Type: "set", Kind: kind, ID: id, Field: field, Elem: elem, Present: false})
		}
	}
	return ops
}

// ---------------------------------------------------------------------------
// Apply a single op with LWW semantics. Local ops carry a fresh (greatest) HLC
// so they always win; remote ops apply only when strictly newer. `local`
// controls whether the op is also recorded in the oplog for push.
// ---------------------------------------------------------------------------

func applyOpTx(tx *sql.Tx, op Op, local bool) (bool, error) {
	h := op.hlc()
	applied := false
	switch op.Type {
	case "presence":
		var curHLC string
		err := tx.QueryRow(`SELECT hlc FROM presence WHERE kind=? AND id=?`, op.Kind, op.ID).Scan(&curHLC)
		if err == sql.ErrNoRows || (err == nil && h.After(parseHLC(curHLC))) {
			if _, e := tx.Exec(`INSERT INTO presence(kind,id,present,hlc) VALUES(?,?,?,?)
				ON CONFLICT(kind,id) DO UPDATE SET present=excluded.present, hlc=excluded.hlc`,
				op.Kind, op.ID, boolInt(op.Present), h.String()); e != nil {
				return false, e
			}
			applied = true
		} else if err != nil {
			return false, err
		}
	case "field":
		var curHLC string
		err := tx.QueryRow(`SELECT hlc FROM fields WHERE kind=? AND id=? AND field=?`, op.Kind, op.ID, op.Field).Scan(&curHLC)
		if err == sql.ErrNoRows || (err == nil && h.After(parseHLC(curHLC))) {
			if _, e := tx.Exec(`INSERT INTO fields(kind,id,field,value,hlc) VALUES(?,?,?,?,?)
				ON CONFLICT(kind,id,field) DO UPDATE SET value=excluded.value, hlc=excluded.hlc`,
				op.Kind, op.ID, op.Field, string(op.Value), h.String()); e != nil {
				return false, e
			}
			applied = true
		} else if err != nil {
			return false, err
		}
	case "set":
		var curHLC string
		err := tx.QueryRow(`SELECT hlc FROM setelems WHERE kind=? AND id=? AND field=? AND elem=?`, op.Kind, op.ID, op.Field, op.Elem).Scan(&curHLC)
		if err == sql.ErrNoRows || (err == nil && h.After(parseHLC(curHLC))) {
			if _, e := tx.Exec(`INSERT INTO setelems(kind,id,field,elem,present,hlc) VALUES(?,?,?,?,?,?)
				ON CONFLICT(kind,id,field,elem) DO UPDATE SET present=excluded.present, hlc=excluded.hlc`,
				op.Kind, op.ID, op.Field, op.Elem, boolInt(op.Present), h.String()); e != nil {
				return false, e
			}
			applied = true
		} else if err != nil {
			return false, err
		}
	}

	if local && applied {
		if _, e := tx.Exec(
			`INSERT INTO oplog(optype,kind,id,field,elem,value,present,hlc,synced)
			 VALUES(?,?,?,?,?,?,?,?,0)`,
			op.Type, op.Kind, op.ID, op.Field, op.Elem, string(op.Value), boolInt(op.Present), h.String(),
		); e != nil {
			return false, e
		}
	}
	return applied, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ---------------------------------------------------------------------------
// LoadSnapshot — materialise merged state back into the frontend shape.
// ---------------------------------------------------------------------------

func (s *Store) LoadSnapshot() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	v, err := s.loadView(s.db)
	if err != nil {
		return "", err
	}

	out := map[string]interface{}{}
	for _, kind := range objectKinds {
		out[pluralOf(kind)] = s.materialize(v, kind)
	}

	// Tags → present tag ids.
	tags := []string{}
	for k, p := range v.presence {
		if !p.present {
			continue
		}
		parts := strings.SplitN(k, "\x1f", 2)
		if parts[0] == "tag" {
			tags = append(tags, parts[1])
		}
	}
	sort.Strings(tags)
	out["tags"] = tags

	// Settings singleton.
	if obj := s.materializeOne(v, "setting", "app"); obj != nil {
		delete(obj, "id")
		out["settings"] = obj
	}

	b, err := json.Marshal(out)
	return string(b), err
}

func (s *Store) materialize(v *view, kind string) []map[string]interface{} {
	out := []map[string]interface{}{}
	for k, p := range v.presence {
		if !p.present {
			continue
		}
		parts := strings.SplitN(k, "\x1f", 2)
		if parts[0] != kind {
			continue
		}
		if obj := s.materializeOne(v, kind, parts[1]); obj != nil {
			out = append(out, obj)
		}
	}
	return out
}

func (s *Store) materializeOne(v *view, kind, id string) map[string]interface{} {
	k := ekey(kind, id)
	if p, ok := v.presence[k]; !ok || !p.present {
		return nil
	}
	obj := map[string]interface{}{"id": id}
	for field, fr := range v.fields[k] {
		var val interface{}
		if err := json.Unmarshal([]byte(fr.value), &val); err == nil {
			obj[field] = val
		}
	}
	for field, elems := range v.sets[k] {
		arr := []interface{}{}
		names := make([]string, 0, len(elems))
		for elem, r := range elems {
			if r.present {
				names = append(names, elem)
			}
		}
		sort.Strings(names) // stable order for set fields
		for _, elem := range names {
			var val interface{}
			if err := json.Unmarshal([]byte(elem), &val); err == nil {
				arr = append(arr, val)
			}
		}
		obj[field] = arr
	}
	return obj
}

// Reset wipes every register + oplog and starts a fresh empty replica (new
// device id + clock). Backs the app's "Delete all data" action.
func (s *Store) Reset() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`DELETE FROM fields; DELETE FROM setelems; DELETE FROM presence; DELETE FROM oplog; DELETE FROM meta;`); err != nil {
		return err
	}
	s.device = s.ensureDeviceID() // meta was cleared → generates a fresh id
	s.clk = newClock(s.device, func() int64 { return s.now() }, HLC{})
	return nil
}

// HasData reports whether any entity is live (used to decide snapshot vs seed).
func (s *Store) HasData() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM presence WHERE present=1`).Scan(&n)
	return n > 0, err
}

// ---------------------------------------------------------------------------
// Misc.
// ---------------------------------------------------------------------------

func (s *Store) ensureDeviceID() string {
	var v string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key='device_id'`).Scan(&v)
	if err == nil && v != "" {
		return v
	}
	// A globally-unique, stable per-install id. It's the HLC tie-break, so two
	// devices must never share one — random bytes, not a timestamp.
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		v = fmt.Sprintf("dev-%d", s.now())
	} else {
		v = "dev-" + hex.EncodeToString(buf[:])
	}
	_, _ = s.db.Exec(`INSERT OR REPLACE INTO meta(key,value) VALUES('device_id',?)`, v)
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
	default:
		return kind + "s"
	}
}
