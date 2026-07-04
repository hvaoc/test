package core

import (
	"encoding/json"
	"testing"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func parse(t *testing.T, js string) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(js), &m); err != nil {
		t.Fatalf("parse snapshot: %v", err)
	}
	return m
}

func TestSnapshotRoundTrip(t *testing.T) {
	s := openTemp(t)
	in := `{
	  "areas":[{"id":"a1","name":"Work"}],
	  "projects":[{"id":"p1","name":"Launch","areaId":"a1"}],
	  "headings":[],
	  "tasks":[{"id":"t1","title":"Ship it","projectId":"p1"},{"id":"t2","title":"Write docs"}],
	  "tags":["Design","Urgent"],
	  "customViews":[{"id":"v1","name":"Hot","query":{}}],
	  "settings":{"showCompleted":true}
	}`
	if err := s.SaveSnapshot(in); err != nil {
		t.Fatal(err)
	}
	out, err := s.LoadSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	m := parse(t, out)
	if len(m["tasks"].([]interface{})) != 2 {
		t.Fatalf("want 2 tasks, got %v", m["tasks"])
	}
	if len(m["tags"].([]interface{})) != 2 {
		t.Fatalf("want 2 tags, got %v", m["tags"])
	}
	if s := m["settings"].(map[string]interface{}); s["showCompleted"] != true {
		t.Fatalf("settings not preserved: %v", s)
	}
}

func TestDeleteAndDiff(t *testing.T) {
	s := openTemp(t)
	_ = s.SaveSnapshot(`{"tasks":[{"id":"t1","title":"A"},{"id":"t2","title":"B"}],"tags":[],"settings":{}}`)
	// Remove t2, edit t1.
	_ = s.SaveSnapshot(`{"tasks":[{"id":"t1","title":"A edited"}],"tags":[],"settings":{}}`)
	out, _ := s.LoadSnapshot()
	tasks := parse(t, out)["tasks"].([]interface{})
	if len(tasks) != 1 {
		t.Fatalf("want 1 task after delete, got %d", len(tasks))
	}
	if tasks[0].(map[string]interface{})["title"] != "A edited" {
		t.Fatalf("edit not applied: %v", tasks[0])
	}
}

// Two devices sharing one mock cloud should converge, and last-writer-wins
// should keep the newer edit.
func TestSyncTwoDevices(t *testing.T) {
	dir := t.TempDir()
	cloud := NewMockAdapter(dir)

	devA := openTemp(t)
	devA.now = seq(1000)
	devA.SetAdapter(cloud)
	devB := openTemp(t)
	devB.now = seq(1000)
	devB.SetAdapter(cloud)

	// A creates a task and pushes.
	if err := devA.SaveSnapshot(`{"tasks":[{"id":"t1","title":"from A"}],"tags":[],"settings":{}}`); err != nil {
		t.Fatal(err)
	}
	mustSync(t, devA)

	// B syncs and should receive t1 (task + the settings singleton = 2 ops).
	res := mustSync(t, devB)
	if res.Applied < 1 {
		t.Fatalf("device B should have applied A's ops, got %d (pulled %d)", res.Applied, res.Pulled)
	}
	tasks := parse(t, res.Snapshot)["tasks"].([]interface{})
	if len(tasks) != 1 || tasks[0].(map[string]interface{})["title"] != "from A" {
		t.Fatalf("B did not converge: %v", tasks)
	}

	// B edits t1 later (newer clock) and pushes; A pulls and must take B's edit.
	devB.now = seq(5000)
	_ = devB.SaveSnapshot(`{"tasks":[{"id":"t1","title":"edited by B"}],"tags":[],"settings":{}}`)
	mustSync(t, devB)
	resA := mustSync(t, devA)
	tA := parse(t, resA.Snapshot)["tasks"].([]interface{})
	if tA[0].(map[string]interface{})["title"] != "edited by B" {
		t.Fatalf("LWW failed, A has: %v", tA[0])
	}

	// A makes an OLDER edit (stale clock) and pushes; B must reject it (keeps B's).
	devA.now = seq(2000) // older than B's 5000 edit
	_ = devA.SaveSnapshot(`{"tasks":[{"id":"t1","title":"stale edit by A"}],"tags":[],"settings":{}}`)
	mustSync(t, devA)
	resB := mustSync(t, devB)
	tB := parse(t, resB.Snapshot)["tasks"].([]interface{})
	if tB[0].(map[string]interface{})["title"] != "edited by B" {
		t.Fatalf("LWW should have kept B's newer edit, got: %v", tB[0])
	}
}

func mustSync(t *testing.T, s *Store) SyncResult {
	t.Helper()
	js, err := s.Sync()
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	var r SyncResult
	if err := json.Unmarshal([]byte(js), &r); err != nil {
		t.Fatalf("sync result: %v", err)
	}
	return r
}

// seq returns a clock that advances by 1ms per call starting at base, so each
// mutation within a snapshot gets a distinct, monotonically increasing stamp.
func seq(base int64) func() int64 {
	n := base - 1
	return func() int64 { n++; return n }
}
