package coordinator

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"things3-clone-desktop/core/record"
	"things3-clone-desktop/server/ysync"
)

// snap builds a whole-state snapshot JSON (the frontend shape) from tasks + settings.
func snap(settings map[string]any, tasks ...map[string]any) string {
	t := make([]any, len(tasks))
	for i, x := range tasks {
		t[i] = x
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

func task(id, title string, extra map[string]any) map[string]any {
	m := map[string]any{"id": id, "title": title, "notes": "", "tags": []any{}}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

// tasksOf materializes the coordinator and indexes its tasks by id.
func tasksOf(t *testing.T, c *Coordinator) map[string]map[string]any {
	t.Helper()
	js, err := c.LoadSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Tasks    []map[string]any `json:"tasks"`
		Settings map[string]any   `json:"settings"`
	}
	_ = json.Unmarshal([]byte(js), &out)
	m := map[string]map[string]any{}
	for _, tk := range out.Tasks {
		m[tk["id"].(string)] = tk
	}
	return m
}

func openCoord(t *testing.T) *Coordinator {
	t.Helper()
	c, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open coordinator: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// Structured round-trip: SaveSnapshot with tasks -> LoadSnapshot returns them, and the
// query pass-throughs see them — proving save + query share ONE record.Store.
func TestStructuredRoundTrip(t *testing.T) {
	c := openCoord(t)

	if err := c.SaveSnapshot(snap(nil,
		task("t1", "Ship v1", map[string]any{"priority": float64(1)}),
		task("t2", "Write docs", nil),
	)); err != nil {
		t.Fatal(err)
	}

	// LoadSnapshot sees them.
	m := tasksOf(t, c)
	if m["t1"]["title"] != "Ship v1" || m["t2"]["title"] != "Write docs" {
		t.Fatalf("load did not return saved tasks: %v", m)
	}

	// Queries (same store) see them.
	rows, err := c.QueryTasks(record.Query{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("QueryTasks saw %d tasks, want 2", len(rows))
	}
	n, err := c.CountTasks(record.Query{})
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("CountTasks = %d, want 2", n)
	}
	got, err := c.GetTask("t1")
	if err != nil || got == nil {
		t.Fatalf("GetTask t1: %v / %v", got, err)
	}
	if got["title"] != "Ship v1" {
		t.Fatalf("GetTask wrong title: %v", got["title"])
	}
}

// Convergence: two coordinators against one in-memory server. A creates a task and
// syncs; B syncs and sees it. A concurrent field edit resolves by LWW; a delete
// propagates. Structured data rides the record op-log (no ygo shared scope).
func TestConvergeThroughServer(t *testing.T) {
	srv := httptest.NewServer(ysync.NewHub(ysync.DevAuth{}, ysync.NewMemPersistence()).Handler())
	defer srv.Close()

	a := openCoord(t)
	b := openCoord(t)
	a.SetServer(srv.URL, "acme:alice")
	b.SetServer(srv.URL, "acme:bob")

	if err := a.SaveSnapshot(snap(nil, task("t1", "Roadmap", map[string]any{"priority": float64(0)}))); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Sync(); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Sync(); err != nil {
		t.Fatal(err)
	}
	if tasksOf(t, b)["t1"]["title"] != "Roadmap" {
		t.Fatalf("B did not receive A's task: %v", tasksOf(t, b))
	}

	// Concurrent edits to different fields converge (LWW per field).
	if err := a.SetTaskField("t1", "title", "Roadmap v2"); err != nil {
		t.Fatal(err)
	}
	if err := b.SetTaskField("t1", "priority", 3); err != nil {
		t.Fatal(err)
	}
	syncBoth(t, a, b)

	at, bt := tasksOf(t, a)["t1"], tasksOf(t, b)["t1"]
	if at["title"] != "Roadmap v2" || bt["title"] != "Roadmap v2" {
		t.Errorf("title edit lost: A=%v B=%v", at["title"], bt["title"])
	}
	if at["priority"] != float64(3) || bt["priority"] != float64(3) {
		t.Errorf("priority edit lost: A=%v B=%v", at["priority"], bt["priority"])
	}

	// A delete propagates to B.
	if err := a.DeleteTask("t1"); err != nil {
		t.Fatal(err)
	}
	syncBoth(t, a, b)
	if _, ok := tasksOf(t, b)["t1"]; ok {
		t.Fatalf("delete did not propagate: B still has t1")
	}
	if _, ok := tasksOf(t, a)["t1"]; ok {
		t.Fatalf("A still has deleted t1")
	}
}

// Notes + settings ride ygo (never the record op-log): a setting and an open-task note
// set on A reach B after sync.
func TestNotesAndSettingsRideYgo(t *testing.T) {
	srv := httptest.NewServer(ysync.NewHub(ysync.DevAuth{}, ysync.NewMemPersistence()).Handler())
	defer srv.Close()

	// Same USER on two devices so the private settings scope is shared.
	a := openCoord(t)
	b := openCoord(t)
	a.SetServer(srv.URL, "acme:alice")
	b.SetServer(srv.URL, "acme:alice")

	// A creates a task, sets a setting, and writes a note (task open).
	a.OpenNote("t1")
	if err := a.SaveSnapshot(snap(
		map[string]any{"theme": "midnight"},
		task("t1", "Roadmap", map[string]any{"notes": "q3 plan"}),
	)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Sync(); err != nil {
		t.Fatal(err)
	}

	// B syncs: gets the structured task (record) + the setting (ygo settings scope).
	if _, err := b.Sync(); err != nil {
		t.Fatal(err)
	}
	if got := settingOf(t, b, "theme"); got != "midnight" {
		t.Fatalf("setting did not ride ygo to B: %v", got)
	}
	// Note does NOT ride the structured stream — B has "" until it opens the task.
	if n, _ := tasksOf(t, b)["t1"]["notes"].(string); n != "" {
		t.Fatalf("note leaked into structured sync; B has %q before opening", n)
	}
	// B opens the task -> pulls its note scope.
	if _, err := b.SyncNote("t1"); err != nil {
		t.Fatal(err)
	}
	if n, _ := tasksOf(t, b)["t1"]["notes"].(string); n != "q3 plan" {
		t.Fatalf("B did not receive the note on open: %q", n)
	}
}

// Reset wipes both layers; the record store is usable again afterward.
func TestResetWipesBoth(t *testing.T) {
	c := openCoord(t)
	if err := c.SaveSnapshot(snap(map[string]any{"theme": "dark"}, task("t1", "x", nil))); err != nil {
		t.Fatal(err)
	}
	if has, _ := c.HasData(); !has {
		t.Fatal("expected data")
	}
	if err := c.Reset(); err != nil {
		t.Fatal(err)
	}
	if has, _ := c.HasData(); has {
		t.Fatal("expected empty after reset")
	}
	// Record store still works: a fresh save/query round-trips.
	if err := c.SaveSnapshot(snap(nil, task("t2", "after reset", nil))); err != nil {
		t.Fatal(err)
	}
	if tasksOf(t, c)["t2"]["title"] != "after reset" {
		t.Fatal("record store unusable after reset")
	}
}

func syncBoth(t *testing.T, a, b *Coordinator) {
	t.Helper()
	// Two rounds each so pushes on one side are visible to the other.
	for i := 0; i < 2; i++ {
		if _, err := a.Sync(); err != nil {
			t.Fatal(err)
		}
		if _, err := b.Sync(); err != nil {
			t.Fatal(err)
		}
	}
}

func settingOf(t *testing.T, c *Coordinator, key string) any {
	t.Helper()
	js, err := c.LoadSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Settings map[string]any `json:"settings"`
	}
	_ = json.Unmarshal([]byte(js), &out)
	return out.Settings[key]
}
