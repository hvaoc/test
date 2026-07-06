package record

import (
	"encoding/json"
	"testing"
)

func mustOpen(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func stateJSON(t *testing.T, m map[string]any) string {
	t.Helper()
	base := map[string]any{
		"areas": []any{}, "projects": []any{}, "headings": []any{},
		"tasks": []any{}, "customViews": []any{}, "tags": []any{}, "settings": map[string]any{},
	}
	for k, v := range m {
		base[k] = v
	}
	b, _ := json.Marshal(base)
	return string(b)
}

func materialize(t *testing.T, s *Store) map[string]any {
	t.Helper()
	js, err := s.Materialize()
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(js), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

func byID(coll any) map[string]map[string]any {
	m := map[string]map[string]any{}
	arr, _ := coll.([]any)
	for _, e := range arr {
		o, _ := e.(map[string]any)
		if id, ok := o["id"].(string); ok {
			m[id] = o
		}
	}
	return m
}

// The whole-state seam round-trips ALL structured kinds (not just tasks), and a
// task's tags survive. Notes come back "" (they live on the ygo layer).
func TestSnapshotRoundTripAllKinds(t *testing.T) {
	s := mustOpen(t)
	state := stateJSON(t, map[string]any{
		"areas":    []any{map[string]any{"id": "a1", "name": "Work"}},
		"projects": []any{map[string]any{"id": "p1", "name": "Launch", "areaId": "a1"}},
		"tasks": []any{
			map[string]any{"id": "t1", "title": "Ship", "projectId": "p1", "priority": float64(2), "notes": "secret", "tags": []any{"urgent", "home"}},
		},
		"tags": []any{"urgent", "home"},
	})
	if err := s.ApplyLocalSnapshot(state); err != nil {
		t.Fatal(err)
	}
	out := materialize(t, s)

	if a := byID(out["areas"])["a1"]; a == nil || a["name"] != "Work" {
		t.Fatalf("area lost: %v", out["areas"])
	}
	if p := byID(out["projects"])["p1"]; p == nil || p["name"] != "Launch" || p["areaId"] != "a1" {
		t.Fatalf("project lost: %v", out["projects"])
	}
	task := byID(out["tasks"])["t1"]
	if task == nil || task["title"] != "Ship" || task["projectId"] != "p1" {
		t.Fatalf("task lost: %v", out["tasks"])
	}
	if task["notes"] != "" {
		t.Errorf("notes must NOT be in the record engine, got %q", task["notes"])
	}
	tags := map[string]bool{}
	for _, x := range task["tags"].([]any) {
		tags[x.(string)] = true
	}
	if !tags["urgent"] || !tags["home"] {
		t.Errorf("task tags lost: %v", task["tags"])
	}
	if gl := out["tags"].([]any); len(gl) != 2 {
		t.Errorf("global tag list lost: %v", gl)
	}
}

// A whole-state save emits only the CHANGED ops (delta-sized), not the dataset.
func TestSnapshotEmitsDeltaOnly(t *testing.T) {
	s := mustOpen(t)
	full := stateJSON(t, map[string]any{"tasks": []any{
		map[string]any{"id": "t1", "title": "A"},
		map[string]any{"id": "t2", "title": "B"},
		map[string]any{"id": "t3", "title": "C"},
	}})
	if err := s.ApplyLocalSnapshot(full); err != nil {
		t.Fatal(err)
	}
	_ = s.MarkAllSyncedForTest(t)

	// Re-save with ONE title changed.
	edited := stateJSON(t, map[string]any{"tasks": []any{
		map[string]any{"id": "t1", "title": "A"},
		map[string]any{"id": "t2", "title": "B2"},
		map[string]any{"id": "t3", "title": "C"},
	}})
	if err := s.ApplyLocalSnapshot(edited); err != nil {
		t.Fatal(err)
	}
	pending, err := s.PendingOps(1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 {
		t.Fatalf("expected exactly 1 delta op for a 1-field change, got %d: %+v", len(pending), pending)
	}
	if pending[0].Op.Field != "title" || pending[0].Op.ID != "t2" {
		t.Fatalf("wrong delta op: %+v", pending[0].Op)
	}
}

// MarkAllSyncedForTest flushes the pending queue (test helper).
func (s *Store) MarkAllSyncedForTest(t *testing.T) error {
	t.Helper()
	p, err := s.PendingOps(100000)
	if err != nil {
		return err
	}
	seqs := make([]int64, len(p))
	for i, so := range p {
		seqs[i] = so.Seq
	}
	return s.MarkSynced(seqs)
}

// opsOf converts a replica's pending ops to a plain []Op (what ApplyRemote takes).
func opsOf(t *testing.T, s *Store) []Op {
	t.Helper()
	p, err := s.PendingOps(100000)
	if err != nil {
		t.Fatal(err)
	}
	ops := make([]Op, len(p))
	seqs := make([]int64, len(p))
	for i, so := range p {
		ops[i] = so.Op
		seqs[i] = so.Seq
	}
	if err := s.MarkSynced(seqs); err != nil {
		t.Fatal(err)
	}
	return ops
}

// Two replicas converge through the op-log (no server): concurrent edits to
// DIFFERENT fields both survive; a concurrent SAME-field edit resolves by LWW —
// the CRDT sync, without ygo.
func TestTwoReplicasConvergeViaOplog(t *testing.T) {
	a := mustOpen(t)
	b := mustOpen(t)

	// A creates a task + project, syncs to B.
	if err := a.ApplyLocalSnapshot(stateJSON(t, map[string]any{
		"projects": []any{map[string]any{"id": "p1", "name": "Launch"}},
		"tasks":    []any{map[string]any{"id": "t1", "title": "Orig", "priority": float64(0)}},
	})); err != nil {
		t.Fatal(err)
	}
	if err := b.ApplyRemote(opsOf(t, a)); err != nil {
		t.Fatal(err)
	}
	if byID(materialize(t, b)["tasks"])["t1"]["title"] != "Orig" {
		t.Fatalf("B didn't receive A's task: %v", materialize(t, b)["tasks"])
	}
	if byID(materialize(t, b)["projects"])["p1"] == nil {
		t.Fatalf("B didn't receive A's project")
	}

	// Concurrent edits to DIFFERENT fields of the same task.
	if err := a.SetTaskField("t1", "title", "Edited by A"); err != nil {
		t.Fatal(err)
	}
	if err := b.SetTaskField("t1", "priority", 5); err != nil {
		t.Fatal(err)
	}
	// Exchange both ways.
	aops, bops := opsOf(t, a), opsOf(t, b)
	if err := b.ApplyRemote(aops); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyRemote(bops); err != nil {
		t.Fatal(err)
	}

	ta := byID(materialize(t, a)["tasks"])["t1"]
	tb := byID(materialize(t, b)["tasks"])["t1"]
	if ta["title"] != "Edited by A" || tb["title"] != "Edited by A" {
		t.Errorf("A's title edit lost: A=%v B=%v", ta["title"], tb["title"])
	}
	if ta["priority"] != float64(5) || tb["priority"] != float64(5) {
		t.Errorf("B's priority edit lost: A=%v B=%v", ta["priority"], tb["priority"])
	}

	// Concurrent SAME-field edit -> deterministic LWW winner, both converge.
	if err := a.SetTaskField("t1", "title", "X-from-A"); err != nil {
		t.Fatal(err)
	}
	if err := b.SetTaskField("t1", "title", "Y-from-B"); err != nil {
		t.Fatal(err)
	}
	aops, bops = opsOf(t, a), opsOf(t, b)
	if err := b.ApplyRemote(aops); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyRemote(bops); err != nil {
		t.Fatal(err)
	}
	fa := byID(materialize(t, a)["tasks"])["t1"]["title"]
	fb := byID(materialize(t, b)["tasks"])["t1"]["title"]
	if fa != fb {
		t.Fatalf("replicas diverged on same-field edit: A=%v B=%v", fa, fb)
	}
}
