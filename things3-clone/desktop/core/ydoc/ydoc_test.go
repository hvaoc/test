package ydoc

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/reearth/ygo/crdt"
)

// snap builds a whole-state snapshot JSON with the given tasks (each a
// map[string]any). Other collections are empty.
func snap(tasks ...map[string]any) string {
	return snapWith(nil, tasks...)
}

// snapWith is snap plus a settings map.
func snapWith(settings map[string]any, tasks ...map[string]any) string {
	t := make([]map[string]any, 0, len(tasks))
	for _, x := range tasks {
		t = append(t, x)
	}
	if settings == nil {
		settings = map[string]any{}
	}
	b, _ := json.Marshal(map[string]any{
		"areas": []any{}, "projects": []any{}, "headings": []any{},
		"tasks": t, "customViews": []any{}, "tags": []any{}, "settings": settings,
	})
	return string(b)
}

func task(id, title, notes string, tags ...string) map[string]any {
	ts := make([]any, len(tags))
	for i, x := range tags {
		ts[i] = x
	}
	return map[string]any{"id": id, "title": title, "notes": notes, "checklist": []any{}, "tags": ts}
}

// loadReplica builds a replica with a fixed device id and copies every scope's
// full state from `from` (the offline-first join: pull all scopes).
func loadReplica(id uint64, from *Engine) *Engine {
	e := NewWithClientID(id)
	for _, sc := range from.Scopes() {
		blob, _ := from.EncodeAll(sc)
		_ = e.LoadScope(sc, blob)
	}
	return e
}

// materializeTasks parses an engine's snapshot and returns tasks keyed by id.
func materializeTasks(t *testing.T, e *Engine) map[string]map[string]any {
	t.Helper()
	js, err := e.Materialize()
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	var out struct {
		Tasks []map[string]any `json:"tasks"`
	}
	if err := json.Unmarshal([]byte(js), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	m := map[string]map[string]any{}
	for _, tk := range out.Tasks {
		m[tk["id"].(string)] = tk
	}
	return m
}

// exchange fully syncs two replicas both directions across every scope either one
// has. Convergence must not depend on order, so we swap full updates per scope.
func exchange(t *testing.T, a, b *Engine) {
	t.Helper()
	seen := map[string]bool{}
	var scopes []string
	for _, s := range append(a.Scopes(), b.Scopes()...) {
		if !seen[s] {
			seen[s] = true
			scopes = append(scopes, s)
		}
	}
	for _, sc := range scopes {
		ua, _ := a.EncodeAll(sc)
		ub, _ := b.EncodeAll(sc)
		if err := b.ApplyUpdate(sc, ua); err != nil {
			t.Fatalf("b.apply(a, %s): %v", sc, err)
		}
		if err := a.ApplyUpdate(sc, ub); err != nil {
			t.Fatalf("a.apply(b, %s): %v", sc, err)
		}
	}
}

func TestConvergence_ConcurrentFieldEdits(t *testing.T) {
	base := New()
	if err := base.ApplyLocalSnapshot(snap(task("t1", "Original", "note"))); err != nil {
		t.Fatal(err)
	}
	a := loadReplica(1, base)
	b := loadReplica(2, base)

	// Offline, concurrent edits to DIFFERENT fields of the same task.
	if err := a.ApplyLocalSnapshot(snap(task("t1", "Edited by A", "note"))); err != nil {
		t.Fatal(err)
	}
	if err := b.ApplyLocalSnapshot(snap(task("t1", "Original", "note by B"))); err != nil {
		t.Fatal(err)
	}

	exchange(t, a, b)

	ma := materializeTasks(t, a)
	mb := materializeTasks(t, b)
	if ma["t1"]["title"] != mb["t1"]["title"] || ma["t1"]["notes"] != mb["t1"]["notes"] {
		t.Fatalf("did not converge:\n A=%v\n B=%v", ma["t1"], mb["t1"])
	}
	if ma["t1"]["title"] != "Edited by A" {
		t.Errorf("A's title edit lost: %v", ma["t1"]["title"])
	}
	if ma["t1"]["notes"] != "note by B" {
		t.Errorf("B's notes edit lost: %v", ma["t1"]["notes"])
	}
}

// The headline requirement: two people editing the SAME note offline must both
// keep their edits — never last-writer-wins clobber, never a user prompt. This now
// happens in a PER-TASK note doc (its own scope).
func TestNotesMerge_NoClobber(t *testing.T) {
	base := New()
	if err := base.ApplyLocalSnapshot(snap(task("t1", "T", "the cat sat"))); err != nil {
		t.Fatal(err)
	}
	a := loadReplica(1, base)
	b := loadReplica(2, base)

	if err := a.ApplyLocalSnapshot(snap(task("t1", "T", "the black cat sat"))); err != nil {
		t.Fatal(err)
	}
	if err := b.ApplyLocalSnapshot(snap(task("t1", "T", "the cat sat down"))); err != nil {
		t.Fatal(err)
	}

	exchange(t, a, b)

	ma := materializeTasks(t, a)
	mb := materializeTasks(t, b)
	notesA, _ := ma["t1"]["notes"].(string)
	notesB, _ := mb["t1"]["notes"].(string)

	if notesA != notesB {
		t.Fatalf("replicas diverged: A=%q B=%q", notesA, notesB)
	}
	if !strings.Contains(notesA, "black") {
		t.Errorf("A's insert lost: %q", notesA)
	}
	if !strings.Contains(notesA, "down") {
		t.Errorf("B's append lost: %q", notesA)
	}
	t.Logf("merged note: %q", notesA)
}

// The note lives in its OWN scope. Editing a note must not change the shared scope
// (so a note edit never rides the always-on shared sync), and must land in note:<id>.
func TestNoteScopeIsolation(t *testing.T) {
	e := New()
	if err := e.ApplyLocalSnapshot(snap(task("t1", "T", ""), task("t2", "T2", ""))); err != nil {
		t.Fatal(err)
	}
	// No notes yet -> no note scopes exist (1M sparsity: no empty per-task docs).
	for _, s := range e.Scopes() {
		if strings.HasPrefix(s, "note:") {
			t.Fatalf("unexpected note scope before any note written: %s", s)
		}
	}
	sharedBefore, _ := e.StateVector(ScopeShared)

	// Add notes to t1 only.
	if err := e.ApplyLocalSnapshot(snap(task("t1", "T", "hello world"), task("t2", "T2", ""))); err != nil {
		t.Fatal(err)
	}
	// Exactly one note scope now exists, for t1.
	got := map[string]bool{}
	for _, s := range e.Scopes() {
		got[s] = true
	}
	if !got[NoteScope("t1")] {
		t.Fatalf("expected note scope for t1, scopes=%v", e.Scopes())
	}
	if got[NoteScope("t2")] {
		t.Fatalf("t2 has no notes but got a note scope")
	}
	// The shared scope did NOT change from adding notes (title/fields unchanged).
	sharedAfter, _ := e.StateVector(ScopeShared)
	if !bytesEqual(sharedBefore, sharedAfter) {
		t.Errorf("writing a note changed the shared scope state vector (it must not)")
	}
	// The note text is retrievable.
	if materializeTasks(t, e)["t1"]["notes"] != "hello world" {
		t.Errorf("note not materialized")
	}
}

// Settings live in a per-USER scope. A settings change must not touch the shared
// scope (the correctness fix: settings must never ride the tenant broadcast).
func TestSettingsScopeIsolation(t *testing.T) {
	e := New()
	if err := e.ApplyLocalSnapshot(snap(task("t1", "T", ""))); err != nil {
		t.Fatal(err)
	}
	sharedBefore, _ := e.StateVector(ScopeShared)
	settingsBefore, _ := e.StateVector(ScopeSettings)

	if err := e.ApplyLocalSnapshot(snapWith(map[string]any{"theme": "dark"}, task("t1", "T", ""))); err != nil {
		t.Fatal(err)
	}

	sharedAfter, _ := e.StateVector(ScopeShared)
	settingsAfter, _ := e.StateVector(ScopeSettings)
	if !bytesEqual(sharedBefore, sharedAfter) {
		t.Errorf("changing a setting changed the SHARED scope (settings must not sync to teammates)")
	}
	if bytesEqual(settingsBefore, settingsAfter) {
		t.Errorf("changing a setting did not change the settings scope")
	}
	// Materialize reflects the setting.
	var out struct {
		Settings map[string]any `json:"settings"`
	}
	js, _ := e.Materialize()
	_ = json.Unmarshal([]byte(js), &out)
	if out.Settings["theme"] != "dark" {
		t.Errorf("settings not materialized: %v", out.Settings)
	}
}

// Regression: prepending to a note (old text is entirely a suffix of the new)
// once indexed o[-1] in the suffix scan. Also covers pure-append and clear.
func TestNotesDiff_EdgeShapes(t *testing.T) {
	cases := []struct{ from, to string }{
		{"draft", "URGENT draft"},
		{"draft", "draft today"},
		{"hello", ""},
		{"", "hello"},
		{"abc", "axc"},
		{"same", "same"},
	}
	for _, c := range cases {
		e := New()
		if err := e.ApplyLocalSnapshot(snap(task("t1", "T", c.from))); err != nil {
			t.Fatalf("%q->%q seed: %v", c.from, c.to, err)
		}
		if err := e.ApplyLocalSnapshot(snap(task("t1", "T", c.to))); err != nil {
			t.Fatalf("%q->%q edit: %v", c.from, c.to, err)
		}
		if got, _ := materializeTasks(t, e)["t1"]["notes"].(string); got != c.to {
			t.Errorf("%q->%q: materialized %q", c.from, c.to, got)
		}
	}
}

func TestTags_ConcurrentAddConverge(t *testing.T) {
	base := New()
	if err := base.ApplyLocalSnapshot(snap(task("t1", "T", "", "home"))); err != nil {
		t.Fatal(err)
	}
	a := loadReplica(1, base)
	b := loadReplica(2, base)

	if err := a.ApplyLocalSnapshot(snap(task("t1", "T", "", "home", "urgent"))); err != nil {
		t.Fatal(err)
	}
	if err := b.ApplyLocalSnapshot(snap(task("t1", "T", "", "home", "work"))); err != nil {
		t.Fatal(err)
	}
	exchange(t, a, b)

	got := materializeTasks(t, a)["t1"]["tags"]
	set := map[string]bool{}
	for _, x := range got.([]any) {
		set[x.(string)] = true
	}
	for _, want := range []string{"home", "urgent", "work"} {
		if !set[want] {
			t.Errorf("tag %q missing after concurrent add: %v", want, got)
		}
	}
}

// A round-trip snapshot must survive materialize unchanged (identity).
func TestSnapshotRoundTrip(t *testing.T) {
	e := New()
	in := snap(
		task("t1", "First", "hello", "home"),
		task("t2", "Second", ""),
	)
	if err := e.ApplyLocalSnapshot(in); err != nil {
		t.Fatal(err)
	}
	m := materializeTasks(t, e)
	if len(m) != 2 {
		t.Fatalf("want 2 tasks, got %d", len(m))
	}
	if m["t1"]["title"] != "First" || m["t1"]["notes"] != "hello" {
		t.Errorf("t1 round-trip mismatch: %v", m["t1"])
	}
	if m["t2"]["title"] != "Second" || m["t2"]["notes"] != "" {
		t.Errorf("t2 round-trip mismatch: %v", m["t2"])
	}
}

// Deleting a task from the snapshot tombstones it in the index.
func TestDeleteEntity(t *testing.T) {
	e := New()
	if err := e.ApplyLocalSnapshot(snap(task("t1", "keep", ""), task("t2", "remove", ""))); err != nil {
		t.Fatal(err)
	}
	if err := e.ApplyLocalSnapshot(snap(task("t1", "keep", ""))); err != nil {
		t.Fatal(err)
	}
	m := materializeTasks(t, e)
	if _, ok := m["t2"]; ok {
		t.Errorf("t2 should be gone, got %v", m)
	}
	if _, ok := m["t1"]; !ok {
		t.Errorf("t1 should remain")
	}
}

// MigrateLegacy lifts settings + notes out of an old single-doc blob into their own
// scopes, and clears them from shared — without losing data.
func TestMigrateLegacy(t *testing.T) {
	// Build an OLD-style single doc: settings + a note both in the shared doc.
	legacy := New()
	sm := legacy.shared.GetMap(settingsRoot)
	yt := legacy.shared.GetText("note:t1")
	idx := legacy.shared.GetMap(indexRoot)
	fm := legacy.shared.GetMap(entityMapName("task", "t1"))
	legacy.shared.Transact(func(txn *crdt.Transaction) {
		idx.Set(txn, indexKey("task", "t1"), true)
		fm.Set(txn, "title", "Task one")
		sm.Set(txn, "theme", "dark")
		yt.Insert(txn, 0, "legacy note body", nil)
	})
	oldBlob, _ := legacy.EncodeAll(ScopeShared)

	// New replica loads the old blob as shared, then migrates.
	e := NewWithClientID(9)
	if err := e.LoadScope(ScopeShared, oldBlob); err != nil {
		t.Fatal(err)
	}
	e.MigrateLegacy()

	// Settings + note are now readable via the normal (scoped) paths.
	m := materializeTasks(t, e)
	if m["t1"]["notes"] != "legacy note body" {
		t.Errorf("note not migrated: %v", m["t1"]["notes"])
	}
	var out struct {
		Settings map[string]any `json:"settings"`
	}
	js, _ := e.Materialize()
	_ = json.Unmarshal([]byte(js), &out)
	if out.Settings["theme"] != "dark" {
		t.Errorf("settings not migrated: %v", out.Settings)
	}
	// A note scope now exists for t1.
	found := false
	for _, s := range e.Scopes() {
		if s == NoteScope("t1") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected note scope after migration, scopes=%v", e.Scopes())
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
