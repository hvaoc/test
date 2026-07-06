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
	a.OpenNote("t1")                    // A opens the task, so its note scope syncs
	if _, err := a.Sync(); err != nil { // push shared + note:t1
		t.Fatal(err)
	}
	if _, err := b.Sync(); err != nil { // pull shared (title only)
		t.Fatal(err)
	}
	if tasksOf(t, b)["t1"]["title"] != "Roadmap" {
		t.Fatalf("device B didn't receive the task: %v", tasksOf(t, b))
	}
	// The note does NOT ride the shared scope — B only gets it on open.
	if n, _ := tasksOf(t, b)["t1"]["notes"].(string); n != "" {
		t.Fatalf("note leaked into shared scope; B has %q before opening", n)
	}
	if _, err := b.SyncNote("t1"); err != nil { // B opens the task -> pulls the note
		t.Fatal(err)
	}
	if n, _ := tasksOf(t, b)["t1"]["notes"].(string); n != "q3 plan" {
		t.Fatalf("device B didn't receive the note on open: %q", n)
	}

	// Concurrent same-note edits, then sync both ways (both have the note open).
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

// Settings sync across the SAME user's devices, but never to a different user in
// the same tenant. This is the per-user (private) scope + the correctness fix.
func TestSettingsAreUserPrivate(t *testing.T) {
	srv := httptest.NewServer(ysync.NewHub(ysync.DevAuth{}, ysync.NewMemPersistence()).Handler())
	defer srv.Close()

	// Two devices of the SAME user (alice), plus a teammate (bob) in the tenant.
	web, _ := Open(t.TempDir())
	phone, _ := Open(t.TempDir())
	mate, _ := Open(t.TempDir())
	web.SetServer(srv.URL, "acme:alice")
	phone.SetServer(srv.URL, "acme:alice")
	mate.SetServer(srv.URL, "acme:bob")

	// Alice changes a setting on web and syncs.
	settingsSnap := `{"areas":[],"projects":[],"headings":[],"tasks":[],"customViews":[],"tags":[],"settings":{"theme":"midnight"}}`
	if err := web.SaveSnapshot(settingsSnap); err != nil {
		t.Fatal(err)
	}
	if _, err := web.Sync(); err != nil {
		t.Fatal(err)
	}

	// Alice's phone syncs and gets the setting (same user room).
	if _, err := phone.Sync(); err != nil {
		t.Fatal(err)
	}
	if got := settingOf(t, phone, "theme"); got != "midnight" {
		t.Fatalf("alice's setting didn't reach her other device: %v", got)
	}

	// Bob syncs and must NOT get alice's setting (different user room).
	if _, err := mate.Sync(); err != nil {
		t.Fatal(err)
	}
	if got := settingOf(t, mate, "theme"); got != nil {
		t.Fatalf("settings leaked to a teammate (must never happen): %v", got)
	}
}

func settingOf(t *testing.T, s *Store, key string) any {
	t.Helper()
	js, err := s.LoadSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Settings map[string]any `json:"settings"`
	}
	_ = json.Unmarshal([]byte(js), &out)
	return out.Settings[key]
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
