package ydstore

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"things3-clone-desktop/server/ysync"
)

func snap(tasks ...map[string]any) string {
	b, _ := json.Marshal(map[string]any{
		"areas": []any{}, "projects": []any{}, "headings": []any{},
		"tasks": tasks, "customViews": []any{}, "tags": []any{}, "settings": map[string]any{},
	})
	return string(b)
}
func task(id, title, notes string) map[string]any {
	return map[string]any{"id": id, "title": title, "notes": notes, "checklist": []any{}, "tags": []any{}}
}

func tasksOf(t *testing.T, s *Store) map[string]map[string]any {
	t.Helper()
	js, err := s.LoadSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Tasks []map[string]any `json:"tasks"`
	}
	_ = json.Unmarshal([]byte(js), &out)
	m := map[string]map[string]any{}
	for _, tk := range out.Tasks {
		m[tk["id"].(string)] = tk
	}
	return m
}

// Data persists across a store reopen (a desktop/mobile app restart).
func TestPersistAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SaveSnapshot(snap(task("t1", "native task", "some notes"))); err != nil {
		t.Fatal(err)
	}

	s2, err := Open(dir) // fresh process, same files dir
	if err != nil {
		t.Fatal(err)
	}
	m := tasksOf(t, s2)
	if m["t1"]["title"] != "native task" || m["t1"]["notes"] != "some notes" {
		t.Fatalf("did not persist: %v", m["t1"])
	}
	// Client id is stable across reopen.
	if s.engine.ClientID() != s2.engine.ClientID() {
		t.Errorf("client id changed across reopen: %d -> %d", s.engine.ClientID(), s2.engine.ClientID())
	}
}

// Two native devices in the same tenant converge through the ysync server, and a
// concurrent same-note edit merges (no clobber) — the desktop/mobile analog of
// the web flow.
func TestTwoDevicesSyncThroughServer(t *testing.T) {
	srv := httptest.NewServer(ysync.NewHub(ysync.DevAuth{}, ysync.NewMemPersistence()).Handler())
	defer srv.Close()

	a, _ := Open(t.TempDir())
	b, _ := Open(t.TempDir())
	a.SetServer(srv.URL, "acme:desktop")
	b.SetServer(srv.URL, "acme:phone")

	if err := a.SaveSnapshot(snap(task("t1", "Roadmap", "q3 plan"))); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Sync(); err != nil { // push
		t.Fatal(err)
	}
	if _, err := b.Sync(); err != nil { // pull
		t.Fatal(err)
	}
	if tasksOf(t, b)["t1"]["title"] != "Roadmap" {
		t.Fatalf("device B didn't receive the task: %v", tasksOf(t, b))
	}

	// Concurrent same-note edits, then sync both ways.
	_ = a.SaveSnapshot(snap(task("t1", "Roadmap", "URGENT q3 plan")))
	_ = b.SaveSnapshot(snap(task("t1", "Roadmap", "q3 plan v2")))
	_, _ = a.Sync()
	_, _ = b.Sync()
	_, _ = a.Sync() // second round to fully converge
	_, _ = b.Sync()

	an, _ := tasksOf(t, a)["t1"]["notes"].(string)
	bn, _ := tasksOf(t, b)["t1"]["notes"].(string)
	if an != bn {
		t.Fatalf("devices diverged: A=%q B=%q", an, bn)
	}
	if !contains(an, "URGENT") || !contains(an, "v2") {
		t.Fatalf("an edit was clobbered: %q", an)
	}
	t.Logf("both devices converged on: %q", an)
}

func TestReset(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.SaveSnapshot(snap(task("t1", "x", "")))
	if has, _ := s.HasData(); !has {
		t.Fatal("expected data")
	}
	if err := s.Reset(); err != nil {
		t.Fatal(err)
	}
	if has, _ := s.HasData(); has {
		t.Fatal("expected empty after reset")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
