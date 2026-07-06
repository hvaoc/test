package record

import (
	"database/sql"
	"encoding/json"
	"sort"
)

// This file gives the record engine the same whole-state seam the app already
// speaks (ApplyLocalSnapshot / Materialize), so the persistence + op-log sync
// backbone can replace the monolithic ygo "shared" document for ALL structured
// entities — areas, projects, headings, tasks, customViews, and the global tag
// list — not just tasks. Each scalar field is an LWW register, task tags are an
// add-wins set, and existence is a presence tombstone (docs/architecture-1m §3).
//
// Two things deliberately do NOT live here (they stay on the ygo text/user layer):
//   - task NOTES  — free text needs character-level merge (per-task ygo doc)
//   - SETTINGS    — per-user scope (never synced to teammates)
// The client coordinator (backend.js / the native App) merges those back in.
//
// The diff only emits ops for fields that actually changed, so a whole-state save
// produces O(change) ops into the op-log — the delta that syncs, not the dataset.

// entityKinds are the collections stored as per-field entities (order = the
// materialization order; it does not affect merge).
var entityKinds = []string{"area", "project", "heading", "task", "customView"}

func pluralKind(kind string) string {
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
	}
	return kind + "s"
}

type recSnapshot struct {
	Areas       []map[string]any `json:"areas"`
	Projects    []map[string]any `json:"projects"`
	Headings    []map[string]any `json:"headings"`
	Tasks       []map[string]any `json:"tasks"`
	CustomViews []map[string]any `json:"customViews"`
	Tags        []string         `json:"tags"`
	// Settings intentionally ignored here — it belongs to the per-user ygo scope.
}

func (s *recSnapshot) collection(kind string) []map[string]any {
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

// recFieldSkip reports fields that are NOT stored as record LWW registers.
func recFieldSkip(kind, field string) bool {
	if field == "id" {
		return true
	}
	if kind == "task" && (field == "notes" || field == "tags") {
		return true // notes -> ygo text layer; tags -> add-wins set below
	}
	return false
}

const presentTrue = true

// ApplyLocalSnapshot diffs the app's whole-state snapshot against the current CRDT
// registers and emits the minimal ops for every structured entity, stamps them with
// local HLCs, applies + logs them, and reprojects any touched task. Notes and
// settings are ignored (handled on the ygo layer).
func (s *Store) ApplyLocalSnapshot(stateJSON string) error {
	var snap recSnapshot
	if err := json.Unmarshal([]byte(stateJSON), &snap); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Bulk-load current state for the diff (one pass each, not N queries).
	curPresent, err := s.loadPresent()
	if err != nil {
		return err
	}
	curFields, err := s.loadFields()
	if err != nil {
		return err
	}
	curTags, err := s.loadTaskTags()
	if err != nil {
		return err
	}

	var ops []Op
	seen := map[string]bool{}

	for _, kind := range entityKinds {
		for _, obj := range snap.collection(kind) {
			id, _ := obj["id"].(string)
			if id == "" {
				continue
			}
			ek := ekey(kind, id)
			seen[ek] = true
			if !curPresent[ek] {
				ops = append(ops, Op{Type: "presence", Kind: kind, ID: id, Present: presentTrue})
			}
			cf := curFields[ek]
			for field, val := range obj {
				if recFieldSkip(kind, field) {
					continue
				}
				c := canonAny(val)
				if cf[field] != c {
					ops = append(ops, Op{Type: "field", Kind: kind, ID: id, Field: field, Value: c})
				}
			}
			if kind == "task" {
				want := map[string]bool{}
				for _, t := range toStrings(obj["tags"]) {
					want[t] = true
					if !curTags[id][t] {
						ops = append(ops, Op{Type: "set", Kind: "task", ID: id, Field: "tags", Elem: canonAny(t), Present: true})
					}
				}
				for t := range curTags[id] {
					if !want[t] {
						ops = append(ops, Op{Type: "set", Kind: "task", ID: id, Field: "tags", Elem: canonAny(t), Present: false})
					}
				}
			}
		}
	}

	// Global tag list -> presence entries under kind "tag".
	for _, name := range snap.Tags {
		ek := ekey("tag", name)
		seen[ek] = true
		if !curPresent[ek] {
			ops = append(ops, Op{Type: "presence", Kind: "tag", ID: name, Present: presentTrue})
		}
	}

	// Entities/tags removed from the snapshot -> presence tombstone.
	for ek, present := range curPresent {
		if present && !seen[ek] {
			kind, id := unekey(ek)
			ops = append(ops, Op{Type: "presence", Kind: kind, ID: id, Present: false})
		}
	}

	if len(ops) == 0 {
		return nil
	}
	return s.applyLocalOps(ops)
}

// applyLocalOps stamps each op with a local HLC, applies + logs it, and reprojects
// every touched task. Caller holds s.mu.
func (s *Store) applyLocalOps(ops []Op) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()          //nolint:errcheck
	touched := map[string]bool{} // task id -> ftsDirty
	for i := range ops {
		ops[i].HLC = s.clk.local()
		applied, err := applyOpTx(tx, ops[i], true)
		if err != nil {
			return err
		}
		if applied && ops[i].Kind == "task" {
			touched[ops[i].ID] = touched[ops[i].ID] || opAffectsFTS(ops[i])
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

// Materialize rebuilds the app's whole-state JSON from the CRDT registers for every
// structured entity. Task notes come back as "" (they live on the ygo layer; the
// coordinator fills them on open) and settings as {} (per-user ygo scope).
func (s *Store) Materialize() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	present, err := s.loadPresent()
	if err != nil {
		return "", err
	}
	fields, err := s.loadFields()
	if err != nil {
		return "", err
	}
	tags, err := s.loadTaskTags()
	if err != nil {
		return "", err
	}

	out := map[string]any{}
	for _, kind := range entityKinds {
		coll := []map[string]any{}
		for ek, p := range present {
			if !p {
				continue
			}
			k, id := unekey(ek)
			if k != kind {
				continue
			}
			obj := map[string]any{"id": id}
			for field, val := range fields[ek] {
				var v any
				if json.Unmarshal([]byte(val), &v) == nil {
					obj[field] = v
				}
			}
			if kind == "task" {
				obj["notes"] = "" // ygo text layer fills this on open
				tset := make([]string, 0, len(tags[id]))
				for t := range tags[id] {
					tset = append(tset, t)
				}
				sort.Strings(tset)
				obj["tags"] = toAnySlice(tset)
			}
			coll = append(coll, obj)
		}
		sort.Slice(coll, func(i, j int) bool { return idOf(coll[i]) < idOf(coll[j]) })
		out[pluralKind(kind)] = coll
	}

	// Global tag list.
	var tagList []string
	for ek, p := range present {
		if !p {
			continue
		}
		if k, name := unekey(ek); k == "tag" {
			tagList = append(tagList, name)
		}
	}
	sort.Strings(tagList)
	out["tags"] = toAnySlice(tagList)
	out["settings"] = map[string]any{} // per-user ygo scope; coordinator fills

	b, err := json.Marshal(out)
	return string(b), err
}

// HasData reports whether any structured entity exists.
func (s *Store) HasData() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM presence WHERE present=1`).Scan(&n)
	return n > 0, err
}

// ---- sync cursor (server high-water mark for pulled ops) ----

// Cursor returns the persisted pull cursor ("" if never synced).
func (s *Store) Cursor() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var v string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key='cursor'`).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return v, err
}

// SetCursor persists the pull cursor after a successful pull.
func (s *Store) SetCursor(cursor string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT OR REPLACE INTO meta(key,value) VALUES('cursor',?)`, cursor)
	return err
}

// ---- bulk loaders + helpers ----

func (s *Store) loadPresent() (map[string]bool, error) {
	rows, err := s.db.Query(`SELECT kind,id,present FROM presence`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var kind, id string
		var p int
		if err := rows.Scan(&kind, &id, &p); err != nil {
			return nil, err
		}
		out[ekey(kind, id)] = p == 1
	}
	return out, rows.Err()
}

func (s *Store) loadFields() (map[string]map[string]string, error) {
	rows, err := s.db.Query(`SELECT kind,id,field,value FROM fields`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]string{}
	for rows.Next() {
		var kind, id, field, value string
		if err := rows.Scan(&kind, &id, &field, &value); err != nil {
			return nil, err
		}
		ek := ekey(kind, id)
		if out[ek] == nil {
			out[ek] = map[string]string{}
		}
		out[ek][field] = value
	}
	return out, rows.Err()
}

func (s *Store) loadTaskTags() (map[string]map[string]bool, error) {
	rows, err := s.db.Query(`SELECT id,elem FROM setelems WHERE kind='task' AND field='tags' AND present=1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]bool{}
	for rows.Next() {
		var id, elem string
		if err := rows.Scan(&id, &elem); err != nil {
			return nil, err
		}
		if out[id] == nil {
			out[id] = map[string]bool{}
		}
		out[id][asString(elem)] = true
	}
	return out, rows.Err()
}

// ekey/unekey pack a (kind,id) into one map key. id may contain ':' so we split on
// the first separator only.
func ekey(kind, id string) string { return kind + "\x00" + id }
func unekey(k string) (kind, id string) {
	for i := 0; i < len(k); i++ {
		if k[i] == 0 {
			return k[:i], k[i+1:]
		}
	}
	return k, ""
}

func toStrings(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func toAnySlice(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

func idOf(m map[string]any) string { s, _ := m["id"].(string); return s }
