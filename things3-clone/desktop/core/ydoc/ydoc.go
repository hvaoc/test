package ydoc

import (
	"encoding/json"
	"sort"
	"unicode/utf16"

	"github.com/reearth/ygo/crdt"
)

// Engine is one CRDT replica: a single ygo document plus the domain schema. It
// exposes the same conceptual seam the app already uses — take a whole-state
// snapshot in, give a whole-state snapshot out, exchange opaque binary updates
// with peers — so the React/React-Native layer and backend.js are unchanged.
type Engine struct {
	doc *crdt.Doc
}

// New creates a fresh replica with a random client id.
func New() *Engine { return &Engine{doc: crdt.New()} }

// NewWithClientID creates a replica with a fixed client id. Persist the id
// (Engine.ClientID) so a reloaded replica keeps a stable identity.
func NewWithClientID(id uint64) *Engine {
	return &Engine{doc: crdt.New(crdt.WithClientID(crdt.ClientID(id)))}
}

// Load rebuilds a replica from a full-state Yjs update (as produced by EncodeAll),
// under the given persisted client id.
func Load(id uint64, update []byte) (*Engine, error) {
	e := NewWithClientID(id)
	if len(update) > 0 {
		if err := crdt.ApplyUpdateV1(e.doc, update, nil); err != nil {
			return nil, err
		}
	}
	return e, nil
}

// ClientID is this replica's stable identity (persist it alongside the data).
func (e *Engine) ClientID() uint64 { return uint64(e.doc.ClientID()) }

// HasData reports whether any entity is present.
func (e *Engine) HasData() bool { return len(e.doc.GetMap(indexRoot).Keys()) > 0 }

// ---- sync primitives (offline-first state-vector diff exchange) ----

// StateVector returns this replica's state vector, wire-encoded. A peer hands us
// theirs; EncodeDiff(theirSV) then returns exactly what they are missing.
func (e *Engine) StateVector() []byte { return crdt.EncodeStateVectorV1(e.doc) }

// EncodeDiff returns every update the holder of sinceSV is missing. Pass nil/empty
// to get the full document state.
func (e *Engine) EncodeDiff(sinceSV []byte) ([]byte, error) {
	if len(sinceSV) == 0 {
		return crdt.EncodeStateAsUpdateV1(e.doc, nil), nil
	}
	sv, err := crdt.DecodeStateVectorV1(sinceSV)
	if err != nil {
		return nil, err
	}
	return crdt.EncodeStateAsUpdateV1(e.doc, sv), nil
}

// EncodeAll returns the full document state as a single update (for persistence
// snapshots and first sync).
func (e *Engine) EncodeAll() []byte { return crdt.EncodeStateAsUpdateV1(e.doc, nil) }

// ApplyUpdate merges a remote update. Idempotent and commutative — applying the
// same update twice, or updates in any order, always converges (the CRDT
// property, provided by Yjs/YATA). No path can surface a conflict to the user.
func (e *Engine) ApplyUpdate(update []byte) error {
	return crdt.ApplyUpdateV1(e.doc, update, nil)
}

// ---- snapshot -> document (local write path) ----

type snapshot struct {
	Areas       []map[string]any `json:"areas"`
	Projects    []map[string]any `json:"projects"`
	Headings    []map[string]any `json:"headings"`
	Tasks       []map[string]any `json:"tasks"`
	CustomViews []map[string]any `json:"customViews"`
	Tags        []string         `json:"tags"`
	Settings    map[string]any   `json:"settings"`
}

func (s *snapshot) collection(kind string) []map[string]any {
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

// ApplyLocalSnapshot diffs the app's whole-state snapshot against the current
// document and applies the minimal set of Y-ops. Per ygo's rule, all reads happen
// here (outside the transaction) and only writes run inside the single Transact.
func (e *Engine) ApplyLocalSnapshot(stateJSON string) error {
	var snap snapshot
	if err := json.Unmarshal([]byte(stateJSON), &snap); err != nil {
		return err
	}

	index := e.doc.GetMap(indexRoot)
	presentIdx := keySet(index.Keys())
	seenIdx := map[string]bool{}

	// writes accumulates closures computed from reads above; they run in one txn.
	var writes []func(txn *crdt.Transaction)

	for _, kind := range objectKinds {
		for _, obj := range snap.collection(kind) {
			id, _ := obj["id"].(string)
			if id == "" {
				continue
			}
			ik := indexKey(kind, id)
			seenIdx[ik] = true
			if !presentIdx[ik] {
				writes = append(writes, func(txn *crdt.Transaction) { index.Set(txn, ik, true) })
			}

			fm := e.doc.GetMap(entityMapName(kind, id))
			cur := fm.Entries()
			seenField := map[string]bool{}
			for field, val := range obj {
				if field == "id" {
					continue
				}
				if fieldIsSpecial(kind, field) {
					continue // notes / tags handled below
				}
				seenField[field] = true
				if cv, ok := cur[field]; !ok || canonJSON(cv) != canonJSON(val) {
					f, v := field, val
					writes = append(writes, func(txn *crdt.Transaction) { fm.Set(txn, f, v) })
				}
			}
			// fields removed from the snapshot
			for field := range cur {
				if !seenField[field] {
					f := field
					writes = append(writes, func(txn *crdt.Transaction) { fm.Delete(txn, f) })
				}
			}

			if kind == "task" {
				// notes -> YText (character-level merge)
				yt := e.doc.GetText(noteTextName(id))
				oldNote := yt.ToString()
				newNote, _ := obj["notes"].(string)
				if oldNote != newNote {
					o, n := oldNote, newNote
					writes = append(writes, func(txn *crdt.Transaction) { applyTextDiff(txn, yt, o, n) })
				}
				// tags -> per-task tag set
				tm := e.doc.GetMap(tagsMapName(id))
				curTags := keySet(tm.Keys())
				wantTags := toStringSet(obj["tags"])
				for t := range wantTags {
					if !curTags[t] {
						tag := t
						writes = append(writes, func(txn *crdt.Transaction) { tm.Set(txn, tag, true) })
					}
				}
				for t := range curTags {
					if !wantTags[t] {
						tag := t
						writes = append(writes, func(txn *crdt.Transaction) { tm.Delete(txn, tag) })
					}
				}
			}
		}
	}

	// global tag list -> index entries "tag:<name>"
	for _, name := range snap.Tags {
		ik := indexKey("tag", name)
		seenIdx[ik] = true
		if !presentIdx[ik] {
			key := ik
			writes = append(writes, func(txn *crdt.Transaction) { index.Set(txn, key, true) })
		}
	}

	// settings -> root map
	if snap.Settings != nil {
		sm := e.doc.GetMap(settingsRoot)
		cur := sm.Entries()
		for k, v := range snap.Settings {
			if cv, ok := cur[k]; !ok || canonJSON(cv) != canonJSON(v) {
				kk, vv := k, v
				writes = append(writes, func(txn *crdt.Transaction) { sm.Set(txn, kk, vv) })
			}
		}
		for k := range cur {
			if _, ok := snap.Settings[k]; !ok {
				kk := k
				writes = append(writes, func(txn *crdt.Transaction) { sm.Delete(txn, kk) })
			}
		}
	}

	// entities/tags removed from the snapshot -> tombstone in the index
	for ik := range presentIdx {
		if !seenIdx[ik] {
			key := ik
			writes = append(writes, func(txn *crdt.Transaction) { index.Delete(txn, key) })
		}
	}

	if len(writes) == 0 {
		return nil
	}
	e.doc.Transact(func(txn *crdt.Transaction) {
		for _, w := range writes {
			w(txn)
		}
	})
	return nil
}

// ---- document -> snapshot (materialize) ----

// Materialize rebuilds the app's whole-state JSON from the merged document.
func (e *Engine) Materialize() (string, error) {
	out := map[string]any{}
	byKind := map[string][]map[string]any{}
	for _, k := range objectKinds {
		byKind[k] = []map[string]any{}
	}
	var tags []string

	index := e.doc.GetMap(indexRoot)
	for _, key := range index.Keys() {
		kind, id := splitIndexKey(key)
		if kind == "tag" {
			tags = append(tags, id)
			continue
		}
		if _, ok := byKind[kind]; !ok {
			continue // unknown kind
		}
		obj := map[string]any{"id": id}
		for f, v := range e.doc.GetMap(entityMapName(kind, id)).Entries() {
			obj[f] = v
		}
		if kind == "task" {
			obj["notes"] = e.doc.GetText(noteTextName(id)).ToString()
			tset := e.doc.GetMap(tagsMapName(id)).Keys()
			sort.Strings(tset)
			obj["tags"] = toAnySlice(tset)
		}
		byKind[kind] = append(byKind[kind], obj)
	}

	for _, k := range objectKinds {
		coll := byKind[k]
		sort.Slice(coll, func(i, j int) bool {
			return idOf(coll[i]) < idOf(coll[j])
		})
		out[pluralOf(k)] = coll
	}
	sort.Strings(tags)
	out["tags"] = toAnySlice(tags)

	settings := e.doc.GetMap(settingsRoot).Entries()
	if settings == nil {
		settings = map[string]any{}
	}
	out["settings"] = settings

	b, err := json.Marshal(out)
	return string(b), err
}

// ---- helpers ----

func canonJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func keySet(keys []string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}

func toStringSet(v any) map[string]bool {
	out := map[string]bool{}
	if arr, ok := v.([]any); ok {
		for _, e := range arr {
			if s, ok := e.(string); ok {
				out[s] = true
			}
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

func isHighSurrogate(u uint16) bool { return u >= 0xD800 && u <= 0xDBFF }

// applyTextDiff turns an old->new string change into the minimal YText
// insert/delete, working in UTF-16 code units (YText's index unit). It replaces
// only the changed middle span, so concurrent edits to different parts of the
// same note merge instead of clobbering.
func applyTextDiff(txn *crdt.Transaction, yt *crdt.YText, oldS, newS string) {
	if oldS == newS {
		return
	}
	o := utf16.Encode([]rune(oldS))
	n := utf16.Encode([]rune(newS))

	// common prefix (in code units)
	p := 0
	for p < len(o) && p < len(n) && o[p] == n[p] {
		p++
	}
	// don't cut between a surrogate pair's halves
	if p > 0 && isHighSurrogate(o[p-1]) {
		p--
	}
	// common suffix, not overlapping the prefix
	s := 0
	for s < len(o)-p && s < len(n)-p && o[len(o)-1-s] == n[len(n)-1-s] {
		s++
	}
	if s > 0 && isHighSurrogate(o[len(o)-1-s]) {
		s--
	}

	if delLen := len(o) - p - s; delLen > 0 {
		yt.Delete(txn, p, delLen)
	}
	if ins := n[p : len(n)-s]; len(ins) > 0 {
		yt.Insert(txn, p, string(utf16.Decode(ins)), nil)
	}
}
