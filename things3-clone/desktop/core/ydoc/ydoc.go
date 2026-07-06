package ydoc

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/reearth/ygo/crdt"
)

// Engine is one device's CRDT replica, split into three independently-synced
// SCOPES (docs/architecture-1m.md §2.2) so each change is routed to the right
// audience:
//
//   - shared  (ScopeShared)      one doc: index + entity field maps + tag sets +
//                                 the global tag list. Synced to every tenant member.
//   - note:<taskId>              one small doc per task holding just that task's
//                                 notes text. Synced ON DEMAND — only while a task is
//                                 open — to the members who open it.
//   - settings (ScopeSettings)   one doc: the settings map. Synced ONLY across the
//                                 same user's own devices, never to teammates.
//
// The app still talks to the engine in whole-state snapshots (ApplyLocalSnapshot /
// Materialize) — that local seam is unchanged. What changed is that SYNC and
// PERSISTENCE are now per-scope: StateVector/EncodeDiff/EncodeAll/ApplyUpdate all
// take a scope, and Scopes() enumerates every doc to persist. Each scope is its own
// ygo document, so its state-vector exchange is independent.
type Engine struct {
	device   uint64 // stable per-device client id, shared by every scope's doc
	shared   *crdt.Doc
	settings *crdt.Doc
	notes    map[string]*crdt.Doc // taskId -> that task's notes doc (created on demand)
}

// Scope names. Note scopes are "note:<taskId>" (see NoteScope).
const (
	ScopeShared     = "shared"
	ScopeSettings   = "settings"
	noteScopePrefix = "note:"
	noteBodyRoot    = "b" // the single YText root inside a per-task note doc
)

// NoteScope is the scope string for a task's notes doc.
func NoteScope(taskID string) string { return noteScopePrefix + taskID }

// noteScopeID returns the taskId of a note scope (and whether scope is one).
func noteScopeID(scope string) (string, bool) {
	if strings.HasPrefix(scope, noteScopePrefix) {
		return scope[len(noteScopePrefix):], true
	}
	return "", false
}

// New creates a fresh replica with a random device client id.
func New() *Engine {
	d := crdt.New()
	id := uint64(d.ClientID())
	return &Engine{
		device:   id,
		shared:   d,
		settings: crdt.New(crdt.WithClientID(crdt.ClientID(id))),
		notes:    map[string]*crdt.Doc{},
	}
}

// NewWithClientID creates a replica with a fixed device client id. Persist the id
// (Engine.ClientID) so a reloaded replica keeps a stable identity.
func NewWithClientID(id uint64) *Engine {
	cid := crdt.ClientID(id)
	return &Engine{
		device:   id,
		shared:   crdt.New(crdt.WithClientID(cid)),
		settings: crdt.New(crdt.WithClientID(cid)),
		notes:    map[string]*crdt.Doc{},
	}
}

// ClientID is this replica's stable device identity (persist it alongside the data).
func (e *Engine) ClientID() uint64 { return e.device }

// doc returns the ygo document backing a scope, creating a note doc on first use.
// Returns nil for an unknown scope.
func (e *Engine) doc(scope string) *crdt.Doc {
	switch scope {
	case ScopeShared:
		return e.shared
	case ScopeSettings:
		return e.settings
	}
	if id, ok := noteScopeID(scope); ok {
		d := e.notes[id]
		if d == nil {
			d = crdt.New(crdt.WithClientID(crdt.ClientID(e.device)))
			e.notes[id] = d
		}
		return d
	}
	return nil
}

// HasData reports whether any shared entity is present.
func (e *Engine) HasData() bool { return len(e.shared.GetMap(indexRoot).Keys()) > 0 }

// Scopes lists every scope with a live local doc, for persistence. shared and
// settings are always present; note scopes appear once their doc exists (i.e. the
// task has notes locally or its note doc was pulled).
func (e *Engine) Scopes() []string {
	out := []string{ScopeShared, ScopeSettings}
	ids := make([]string, 0, len(e.notes))
	for id := range e.notes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		out = append(out, NoteScope(id))
	}
	return out
}

// ---- sync primitives (offline-first state-vector diff exchange), per scope ----

// StateVector returns a scope's state vector, wire-encoded.
func (e *Engine) StateVector(scope string) ([]byte, error) {
	d := e.doc(scope)
	if d == nil {
		return nil, fmt.Errorf("ydoc: unknown scope %q", scope)
	}
	return crdt.EncodeStateVectorV1(d), nil
}

// EncodeDiff returns every update in a scope that the holder of sinceSV is missing.
// Pass nil/empty to get the scope's full state.
func (e *Engine) EncodeDiff(scope string, sinceSV []byte) ([]byte, error) {
	d := e.doc(scope)
	if d == nil {
		return nil, fmt.Errorf("ydoc: unknown scope %q", scope)
	}
	if len(sinceSV) == 0 {
		return crdt.EncodeStateAsUpdateV1(d, nil), nil
	}
	sv, err := crdt.DecodeStateVectorV1(sinceSV)
	if err != nil {
		return nil, err
	}
	return crdt.EncodeStateAsUpdateV1(d, sv), nil
}

// EncodeAll returns a scope's full document state as one update (persistence).
func (e *Engine) EncodeAll(scope string) ([]byte, error) {
	d := e.doc(scope)
	if d == nil {
		return nil, fmt.Errorf("ydoc: unknown scope %q", scope)
	}
	return crdt.EncodeStateAsUpdateV1(d, nil), nil
}

// ApplyUpdate merges a remote update into a scope. Creates the note doc if this is
// the first time we see it (an on-demand pull of a task's notes). Idempotent and
// commutative — the CRDT convergence property, per scope.
func (e *Engine) ApplyUpdate(scope string, update []byte) error {
	d := e.doc(scope)
	if d == nil {
		return fmt.Errorf("ydoc: unknown scope %q", scope)
	}
	return crdt.ApplyUpdateV1(d, update, nil)
}

// LoadScope applies a persisted full-state blob into a scope's doc (startup restore).
func (e *Engine) LoadScope(scope string, snapshot []byte) error {
	if len(snapshot) == 0 {
		return nil
	}
	return e.ApplyUpdate(scope, snapshot)
}

// ---- snapshot -> documents (local write path) ----

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
// documents and applies the minimal set of Y-ops, routing each part to its scope:
// entities/tags -> shared, each task's notes -> that task's note doc (created only
// if the task actually has notes), settings -> the settings doc. Per ygo's rule,
// all reads happen before the writes, and each doc's writes run in its own Transact.
func (e *Engine) ApplyLocalSnapshot(stateJSON string) error {
	var snap snapshot
	if err := json.Unmarshal([]byte(stateJSON), &snap); err != nil {
		return err
	}

	index := e.shared.GetMap(indexRoot)
	presentIdx := keySet(index.Keys())
	seenIdx := map[string]bool{}

	var sharedWrites []func(txn *crdt.Transaction)
	noteWrites := map[string][]func(txn *crdt.Transaction){} // taskId -> writes on its note doc

	for _, kind := range objectKinds {
		for _, obj := range snap.collection(kind) {
			id, _ := obj["id"].(string)
			if id == "" {
				continue
			}
			ik := indexKey(kind, id)
			seenIdx[ik] = true
			if !presentIdx[ik] {
				sharedWrites = append(sharedWrites, func(txn *crdt.Transaction) { index.Set(txn, ik, true) })
			}

			fm := e.shared.GetMap(entityMapName(kind, id))
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
					sharedWrites = append(sharedWrites, func(txn *crdt.Transaction) { fm.Set(txn, f, v) })
				}
			}
			for field := range cur {
				if !seenField[field] {
					f := field
					sharedWrites = append(sharedWrites, func(txn *crdt.Transaction) { fm.Delete(txn, f) })
				}
			}

			if kind == "task" {
				// notes -> this task's own note doc (char-level merge). Only touch a
				// note doc if the task has notes or one already exists — never create
				// an empty note doc per task (that would defeat 1M sparsity).
				newNote, _ := obj["notes"].(string)
				nd := e.notes[id]
				if nd != nil || newNote != "" {
					if nd == nil {
						nd = crdt.New(crdt.WithClientID(crdt.ClientID(e.device)))
						e.notes[id] = nd
					}
					yt := nd.GetText(noteBodyRoot)
					oldNote := yt.ToString()
					if oldNote != newNote {
						o, n := oldNote, newNote
						noteWrites[id] = append(noteWrites[id], func(txn *crdt.Transaction) { applyTextDiff(txn, yt, o, n) })
					}
				}

				// tags -> per-task tag set (in shared)
				tm := e.shared.GetMap(tagsMapName(id))
				curTags := keySet(tm.Keys())
				wantTags := toStringSet(obj["tags"])
				for t := range wantTags {
					if !curTags[t] {
						tag := t
						sharedWrites = append(sharedWrites, func(txn *crdt.Transaction) { tm.Set(txn, tag, true) })
					}
				}
				for t := range curTags {
					if !wantTags[t] {
						tag := t
						sharedWrites = append(sharedWrites, func(txn *crdt.Transaction) { tm.Delete(txn, tag) })
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
			sharedWrites = append(sharedWrites, func(txn *crdt.Transaction) { index.Set(txn, key, true) })
		}
	}

	// entities/tags removed from the snapshot -> tombstone in the index
	for ik := range presentIdx {
		if !seenIdx[ik] {
			key := ik
			sharedWrites = append(sharedWrites, func(txn *crdt.Transaction) { index.Delete(txn, key) })
		}
	}

	// settings -> settings doc's root map
	var settingsWrites []func(txn *crdt.Transaction)
	if snap.Settings != nil {
		sm := e.settings.GetMap(settingsRoot)
		cur := sm.Entries()
		for k, v := range snap.Settings {
			if cv, ok := cur[k]; !ok || canonJSON(cv) != canonJSON(v) {
				kk, vv := k, v
				settingsWrites = append(settingsWrites, func(txn *crdt.Transaction) { sm.Set(txn, kk, vv) })
			}
		}
		for k := range cur {
			if _, ok := snap.Settings[k]; !ok {
				kk := k
				settingsWrites = append(settingsWrites, func(txn *crdt.Transaction) { sm.Delete(txn, kk) })
			}
		}
	}

	// Apply each doc's writes in its own transaction.
	e.applyOn(e.shared, sharedWrites)
	e.applyOn(e.settings, settingsWrites)
	for id, ws := range noteWrites {
		e.applyOn(e.notes[id], ws)
	}
	return nil
}

func (e *Engine) applyOn(d *crdt.Doc, writes []func(txn *crdt.Transaction)) {
	if d == nil || len(writes) == 0 {
		return
	}
	d.Transact(func(txn *crdt.Transaction) {
		for _, w := range writes {
			w(txn)
		}
	})
}

// ---- documents -> snapshot (materialize) ----

// Materialize rebuilds the app's whole-state JSON from the merged documents. A
// task's notes come from its local note doc if present, else "" (on-demand: notes
// for tasks not yet opened/synced are empty until their scope is pulled).
func (e *Engine) Materialize() (string, error) {
	out := map[string]any{}
	byKind := map[string][]map[string]any{}
	for _, k := range objectKinds {
		byKind[k] = []map[string]any{}
	}
	var tags []string

	index := e.shared.GetMap(indexRoot)
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
		for f, v := range e.shared.GetMap(entityMapName(kind, id)).Entries() {
			obj[f] = v
		}
		if kind == "task" {
			note := ""
			if nd := e.notes[id]; nd != nil {
				note = nd.GetText(noteBodyRoot).ToString()
			}
			obj["notes"] = note
			tset := e.shared.GetMap(tagsMapName(id)).Keys()
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

	settings := e.settings.GetMap(settingsRoot).Entries()
	if settings == nil {
		settings = map[string]any{}
	}
	out["settings"] = settings

	b, err := json.Marshal(out)
	return string(b), err
}

// ---- legacy migration ----

// MigrateLegacy moves settings and notes OUT of the shared doc, where the old
// single-document schema kept them, into their own scopes. Call it once, right
// after loading an old-format snapshot into the shared scope (LoadScope(ScopeShared,
// oldBlob)). It reads the shared doc's "settings" map and "note:<taskId>" texts,
// copies them into the settings/note docs, and clears them from shared so the shared
// scope no longer carries per-user settings (the correctness fix) or note bulk.
func (e *Engine) MigrateLegacy() {
	// settings map -> settings doc
	legacySettings := e.shared.GetMap(settingsRoot)
	if ent := legacySettings.Entries(); len(ent) > 0 {
		dm := e.settings.GetMap(settingsRoot)
		e.settings.Transact(func(txn *crdt.Transaction) {
			for k, v := range ent {
				dm.Set(txn, k, v)
			}
		})
		e.shared.Transact(func(txn *crdt.Transaction) {
			for k := range ent {
				legacySettings.Delete(txn, k)
			}
		})
	}

	// "note:<taskId>" YTexts -> per-task note docs
	index := e.shared.GetMap(indexRoot)
	for _, key := range index.Keys() {
		kind, id := splitIndexKey(key)
		if kind != "task" {
			continue
		}
		legacyNote := e.shared.GetText(noteTextName(id))
		s := legacyNote.ToString()
		if s == "" {
			continue
		}
		nd := crdt.New(crdt.WithClientID(crdt.ClientID(e.device)))
		e.notes[id] = nd
		yt := nd.GetText(noteBodyRoot)
		nd.Transact(func(txn *crdt.Transaction) { yt.Insert(txn, 0, s, nil) })
		// clear the note text from shared so it stops riding the shared scope
		e.shared.Transact(func(txn *crdt.Transaction) { applyTextDiff(txn, legacyNote, s, "") })
	}
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

	p := 0
	for p < len(o) && p < len(n) && o[p] == n[p] {
		p++
	}
	if p > 0 && isHighSurrogate(o[p-1]) {
		p--
	}
	s := 0
	for s < len(o)-p && s < len(n)-p && o[len(o)-1-s] == n[len(n)-1-s] {
		s++
	}
	if idx := len(o) - 1 - s; s > 0 && idx >= 0 && isHighSurrogate(o[idx]) {
		s--
	}

	if delLen := len(o) - p - s; delLen > 0 {
		yt.Delete(txn, p, delLen)
	}
	if ins := n[p : len(n)-s]; len(ins) > 0 {
		yt.Insert(txn, p, string(utf16.Decode(ins)), nil)
	}
}
