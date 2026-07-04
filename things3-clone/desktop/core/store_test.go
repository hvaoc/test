package core

import (
	"encoding/json"
	"sort"
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

// taskByID finds a materialised task in a snapshot map.
func taskByID(t *testing.T, snap map[string]interface{}, id string) map[string]interface{} {
	t.Helper()
	for _, raw := range snap["tasks"].([]interface{}) {
		tk := raw.(map[string]interface{})
		if tk["id"] == id {
			return tk
		}
	}
	return nil
}

func TestSnapshotRoundTrip(t *testing.T) {
	s := openTemp(t)
	in := `{
	  "areas":[{"id":"a1","name":"Work"}],
	  "projects":[{"id":"p1","name":"Launch","areaId":"a1"}],
	  "headings":[],
	  "tasks":[{"id":"t1","title":"Ship it","projectId":"p1","tags":["Design","Urgent"]},{"id":"t2","title":"Write docs"}],
	  "tags":["Design","Urgent"],
	  "customViews":[{"id":"v1","name":"Hot","query":{"match":"all"}}],
	  "settings":{"showCompleted":true}
	}`
	if err := s.SaveSnapshot(in); err != nil {
		t.Fatal(err)
	}
	m := parse(t, mustLoad(t, s))
	if len(m["tasks"].([]interface{})) != 2 {
		t.Fatalf("want 2 tasks, got %v", m["tasks"])
	}
	if len(m["tags"].([]interface{})) != 2 {
		t.Fatalf("want 2 tags, got %v", m["tags"])
	}
	if s := m["settings"].(map[string]interface{}); s["showCompleted"] != true {
		t.Fatalf("settings not preserved: %v", s)
	}
	tk := taskByID(t, m, "t1")
	if got := tk["tags"].([]interface{}); len(got) != 2 {
		t.Fatalf("task tags not preserved: %v", got)
	}
}

func TestDeleteAndDiff(t *testing.T) {
	s := openTemp(t)
	_ = s.SaveSnapshot(`{"tasks":[{"id":"t1","title":"A"},{"id":"t2","title":"B"}],"tags":[],"settings":{}}`)
	_ = s.SaveSnapshot(`{"tasks":[{"id":"t1","title":"A edited"}],"tags":[],"settings":{}}`)
	m := parse(t, mustLoad(t, s))
	tasks := m["tasks"].([]interface{})
	if len(tasks) != 1 {
		t.Fatalf("want 1 task after delete, got %d", len(tasks))
	}
	if tasks[0].(map[string]interface{})["title"] != "A edited" {
		t.Fatalf("edit not applied: %v", tasks[0])
	}
}

// The headline guarantee: two devices concurrently editing DIFFERENT fields of
// the same task both keep their change (whole-entity LWW would lose one).
func TestConcurrentDifferentFieldsBothSurvive(t *testing.T) {
	dir := t.TempDir()
	cloud := NewMockAdapter(dir)

	a := openTemp(t)
	a.now = seq(1000)
	a.SetAdapter(cloud)
	b := openTemp(t)
	b.now = seq(1000)
	b.SetAdapter(cloud)

	// Both start from the same task, synced.
	base := `{"tasks":[{"id":"t1","title":"Original","deadline":null,"priority":null}],"tags":[],"settings":{}}`
	mustSave(t, a, base)
	mustSync(t, a)
	mustSync(t, b)

	// Concurrent edits: A changes the title, B changes the deadline.
	a.now = seq(2000)
	mustSave(t, a, `{"tasks":[{"id":"t1","title":"A's title","deadline":null,"priority":null}],"tags":[],"settings":{}}`)
	b.now = seq(2000)
	mustSave(t, b, `{"tasks":[{"id":"t1","title":"Original","deadline":"2026-08-01","priority":null}],"tags":[],"settings":{}}`)

	// Exchange in both directions until converged.
	mustSync(t, a)
	mustSync(t, b)
	mustSync(t, a)

	ra := taskByID(t, parse(t, mustLoad(t, a)), "t1")
	rb := taskByID(t, parse(t, mustLoad(t, b)), "t1")
	for _, r := range []map[string]interface{}{ra, rb} {
		if r["title"] != "A's title" {
			t.Fatalf("lost A's title edit: %v", r["title"])
		}
		if r["deadline"] != "2026-08-01" {
			t.Fatalf("lost B's deadline edit: %v", r["deadline"])
		}
	}
}

// Concurrent tag additions on two devices both survive (add-wins set CRDT).
func TestConcurrentTagAddsMerge(t *testing.T) {
	dir := t.TempDir()
	cloud := NewMockAdapter(dir)
	a := openTemp(t)
	a.now = seq(1000)
	a.SetAdapter(cloud)
	b := openTemp(t)
	b.now = seq(1000)
	b.SetAdapter(cloud)

	mustSave(t, a, `{"tasks":[{"id":"t1","title":"T","tags":["Base"]}],"tags":["Base"],"settings":{}}`)
	mustSync(t, a)
	mustSync(t, b)

	a.now = seq(3000)
	mustSave(t, a, `{"tasks":[{"id":"t1","title":"T","tags":["Base","FromA"]}],"tags":["Base","FromA"],"settings":{}}`)
	b.now = seq(3000)
	mustSave(t, b, `{"tasks":[{"id":"t1","title":"T","tags":["Base","FromB"]}],"tags":["Base","FromB"],"settings":{}}`)

	mustSync(t, a)
	mustSync(t, b)
	mustSync(t, a)

	got := tagsOf(t, taskByID(t, parse(t, mustLoad(t, a)), "t1"))
	want := []string{"Base", "FromA", "FromB"}
	if !eqStrings(got, want) {
		t.Fatalf("tags did not merge add-wins: got %v want %v", got, want)
	}
}

// Same-field conflict: the higher HLC wins, deterministically on both replicas.
func TestSameFieldLWWDeterministic(t *testing.T) {
	dir := t.TempDir()
	cloud := NewMockAdapter(dir)
	a := openTemp(t)
	a.now = seq(1000)
	a.SetAdapter(cloud)
	b := openTemp(t)
	b.now = seq(1000)
	b.SetAdapter(cloud)

	mustSave(t, a, `{"tasks":[{"id":"t1","title":"base"}],"tags":[],"settings":{}}`)
	mustSync(t, a)
	mustSync(t, b)

	// B's edit has the strictly higher wall time → B must win everywhere.
	a.now = seq(4000)
	mustSave(t, a, `{"tasks":[{"id":"t1","title":"edit-A"}],"tags":[],"settings":{}}`)
	b.now = seq(9000)
	mustSave(t, b, `{"tasks":[{"id":"t1","title":"edit-B"}],"tags":[],"settings":{}}`)

	mustSync(t, a)
	mustSync(t, b)
	mustSync(t, a)

	ta := taskByID(t, parse(t, mustLoad(t, a)), "t1")["title"]
	tb := taskByID(t, parse(t, mustLoad(t, b)), "t1")["title"]
	if ta != "edit-B" || tb != "edit-B" {
		t.Fatalf("LWW not deterministic: A=%v B=%v (want edit-B)", ta, tb)
	}
}

// ---- helpers ----

func mustSave(t *testing.T, s *Store, js string) {
	t.Helper()
	if err := s.SaveSnapshot(js); err != nil {
		t.Fatalf("save: %v", err)
	}
}

func mustLoad(t *testing.T, s *Store) string {
	t.Helper()
	js, err := s.LoadSnapshot()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return js
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

func tagsOf(t *testing.T, task map[string]interface{}) []string {
	t.Helper()
	var out []string
	for _, v := range task["tags"].([]interface{}) {
		out = append(out, v.(string))
	}
	sort.Strings(out)
	return out
}

func eqStrings(a, b []string) bool {
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

// seq returns a clock that advances 1ms per call from base, so each mutation
// gets a distinct, monotonically increasing physical stamp.
func seq(base int64) func() int64 {
	n := base - 1
	return func() int64 { n++; return n }
}
