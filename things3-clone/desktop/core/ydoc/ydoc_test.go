package ydoc

import (
	"encoding/json"
	"strings"
	"testing"
)

// snap builds a whole-state snapshot JSON with the given tasks (each a
// map[string]any). Other collections are empty.
func snap(tasks ...map[string]any) string {
	t := make([]map[string]any, 0, len(tasks))
	for _, x := range tasks {
		t = append(t, x)
	}
	b, _ := json.Marshal(map[string]any{
		"areas": []any{}, "projects": []any{}, "headings": []any{},
		"tasks": t, "customViews": []any{}, "tags": []any{}, "settings": map[string]any{},
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

// exchange fully syncs two replicas both directions (offline-first: swap full
// updates). Convergence must not depend on order, so we do it twice.
func exchange(t *testing.T, a, b *Engine) {
	t.Helper()
	ua, ub := a.EncodeAll(), b.EncodeAll()
	if err := b.ApplyUpdate(ua); err != nil {
		t.Fatalf("b.apply(a): %v", err)
	}
	if err := a.ApplyUpdate(ub); err != nil {
		t.Fatalf("a.apply(b): %v", err)
	}
}

func TestConvergence_ConcurrentFieldEdits(t *testing.T) {
	// Shared base: one task.
	base := New()
	if err := base.ApplyLocalSnapshot(snap(task("t1", "Original", "note"))); err != nil {
		t.Fatal(err)
	}
	seed := base.EncodeAll()

	a, _ := Load(1, seed)
	b, _ := Load(2, seed)

	// Offline, concurrent edits to DIFFERENT fields of the same task.
	if err := a.ApplyLocalSnapshot(snap(task("t1", "Edited by A", "note"))); err != nil {
		t.Fatal(err)
	}
	// b keeps the title but changes notes.
	if err := b.ApplyLocalSnapshot(snap(task("t1", "Original", "note by B"))); err != nil {
		t.Fatal(err)
	}

	exchange(t, a, b)

	ma := materializeTasks(t, a)
	mb := materializeTasks(t, b)
	// Both replicas converge to identical state.
	if ma["t1"]["title"] != mb["t1"]["title"] || ma["t1"]["notes"] != mb["t1"]["notes"] {
		t.Fatalf("did not converge:\n A=%v\n B=%v", ma["t1"], mb["t1"])
	}
	// A's title edit and B's notes edit both survive (different registers → no loss).
	if ma["t1"]["title"] != "Edited by A" {
		t.Errorf("A's title edit lost: %v", ma["t1"]["title"])
	}
	if ma["t1"]["notes"] != "note by B" {
		t.Errorf("B's notes edit lost: %v", ma["t1"]["notes"])
	}
}

// The headline requirement: two people editing the SAME note offline must both
// keep their edits — never last-writer-wins clobber, never a user prompt.
func TestNotesMerge_NoClobber(t *testing.T) {
	base := New()
	if err := base.ApplyLocalSnapshot(snap(task("t1", "T", "the cat sat"))); err != nil {
		t.Fatal(err)
	}
	seed := base.EncodeAll()

	a, _ := Load(1, seed)
	b, _ := Load(2, seed)

	// A inserts a word in the middle; B appends at the end. Fully offline.
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
	// Both edits must be present in the merged text.
	if !strings.Contains(notesA, "black") {
		t.Errorf("A's insert lost: %q", notesA)
	}
	if !strings.Contains(notesA, "down") {
		t.Errorf("B's append lost: %q", notesA)
	}
	t.Logf("merged note: %q", notesA)
}

// Regression: prepending to a note (old text is entirely a suffix of the new)
// once indexed o[-1] in the suffix scan. Also covers pure-append and clear.
func TestNotesDiff_EdgeShapes(t *testing.T) {
	cases := []struct{ from, to string }{
		{"draft", "URGENT draft"}, // prepend (old is a suffix of new)
		{"draft", "draft today"},  // append (old is a prefix of new)
		{"hello", ""},             // clear
		{"", "hello"},             // fill
		{"abc", "axc"},            // middle replace
		{"same", "same"},          // no-op
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
	seed := base.EncodeAll()
	a, _ := Load(1, seed)
	b, _ := Load(2, seed)

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
		task("t2", "Second", "", ),
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
