package ysync

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"things3-clone-desktop/core/ydoc"
)

// --- HTTP client helpers (exercise the real router + wire format) ------------

type client struct {
	t        *testing.T
	srv      *httptest.Server
	token    string
	engine   *ydoc.Engine
	serverSV map[string][]byte // per-scope server state vector from the last pull
}

func newClient(t *testing.T, srv *httptest.Server, token string) *client {
	return &client{t: t, srv: srv, token: token, engine: ydoc.New(), serverSV: map[string][]byte{}}
}

func (c *client) post(path string, body any) map[string]any {
	c.t.Helper()
	b, _ := json.Marshal(body)
	resp, err := postJSON(c.srv.URL+path, c.token, b)
	if err != nil {
		c.t.Fatalf("%s: %v", path, err)
	}
	return resp
}

// pullScope fetches+applies what this client is missing in one scope and remembers
// the server's state vector for it; pushScope then sends exactly what the server is
// missing — the real offline-first flow, now per-scope.
func (c *client) pullScope(scope string) {
	sv, _ := c.engine.StateVector(scope)
	resp := c.post("/v1/pull", map[string]string{"scope": scope, "sv": b64enc(sv)})
	if u, _ := resp["update"].(string); u != "" {
		upd, _ := b64dec(u)
		if len(upd) > 0 {
			if err := c.engine.ApplyUpdate(scope, upd); err != nil {
				c.t.Fatalf("apply pulled update (%s): %v", scope, err)
			}
		}
	}
	if s, _ := resp["sv"].(string); s != "" {
		c.serverSV[scope], _ = b64dec(s)
	}
}
func (c *client) pushScope(scope string) {
	diff, err := c.engine.EncodeDiff(scope, c.serverSV[scope])
	if err != nil {
		c.t.Fatalf("encode diff (%s): %v", scope, err)
	}
	c.post("/v1/push", map[string]string{"scope": scope, "update": b64enc(diff)})
}

// pull/push iterate the client's live scopes (shared, settings, and any note
// scopes it already holds). Notes for tasks the client hasn't opened are NOT
// pulled here — that's on-demand via syncNote.
func (c *client) pull() {
	for _, s := range c.engine.Scopes() {
		c.pullScope(s)
	}
}
func (c *client) push() {
	for _, s := range c.engine.Scopes() {
		c.pushScope(s)
	}
}

// syncNote simulates opening a task: it syncs just that task's note scope on demand.
func (c *client) syncNote(taskID string) {
	scope := ydoc.NoteScope(taskID)
	c.pushScope(scope)
	c.pullScope(scope)
}

func (c *client) tasks() map[string]map[string]any {
	c.t.Helper()
	js, _ := c.engine.Materialize()
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

// --- tests -------------------------------------------------------------------

// Two users in the SAME tenant collaborate through the server: what Alice writes,
// Bob receives — and concurrent edits to the same note merge (no clobber).
func TestTeamCollaboration_SameTenant(t *testing.T) {
	srv := httptest.NewServer(NewHub(DevAuth{}, NewMemPersistence()).Handler())
	defer srv.Close()

	alice := newClient(t, srv, "acme:alice")
	bob := newClient(t, srv, "acme:bob")

	// Alice creates a task offline, then pushes.
	if err := alice.engine.ApplyLocalSnapshot(snap(task("t1", "Ship v1", "draft"))); err != nil {
		t.Fatal(err)
	}
	alice.push()

	// Bob pulls and sees Alice's task title (shared scope). The note is NOT here —
	// it lives in its own scope and arrives only when Bob opens the task.
	bob.pull()
	if bob.tasks()["t1"]["title"] != "Ship v1" {
		t.Fatalf("bob didn't receive alice's task: %v", bob.tasks())
	}
	if n, _ := bob.tasks()["t1"]["notes"].(string); n != "" {
		t.Fatalf("note should not ride the shared scope; bob already has %q", n)
	}
	// Bob opens the task -> syncs the note scope on demand, getting the base "draft".
	bob.syncNote("t1")
	if n, _ := bob.tasks()["t1"]["notes"].(string); n != "draft" {
		t.Fatalf("bob didn't receive the note on open: %q", n)
	}

	// Concurrent edits to the SAME note: Alice prepends, Bob appends. Both offline.
	if err := alice.engine.ApplyLocalSnapshot(snap(task("t1", "Ship v1", "URGENT draft"))); err != nil {
		t.Fatal(err)
	}
	if err := bob.engine.ApplyLocalSnapshot(snap(task("t1", "Ship v1", "draft today"))); err != nil {
		t.Fatal(err)
	}
	alice.push()
	bob.push()
	alice.pull()
	bob.pull()

	an, _ := alice.tasks()["t1"]["notes"].(string)
	bn, _ := bob.tasks()["t1"]["notes"].(string)
	if an != bn {
		t.Fatalf("team diverged: alice=%q bob=%q", an, bn)
	}
	if !strings.Contains(an, "URGENT") || !strings.Contains(an, "today") {
		t.Fatalf("an edit was clobbered (must never happen): %q", an)
	}
	t.Logf("merged note both teammates see: %q", an)
}

// A different tenant must NOT see another tenant's data.
func TestTenantIsolation(t *testing.T) {
	srv := httptest.NewServer(NewHub(DevAuth{}, NewMemPersistence()).Handler())
	defer srv.Close()

	acme := newClient(t, srv, "acme:alice")
	other := newClient(t, srv, "globex:carol")

	if err := acme.engine.ApplyLocalSnapshot(snap(task("secret", "Acme roadmap", ""))); err != nil {
		t.Fatal(err)
	}
	acme.push()

	other.pull()
	if len(other.tasks()) != 0 {
		t.Fatalf("cross-tenant leak: globex saw %v", other.tasks())
	}
}

// A tenant's document survives a server restart (persistence).
func TestPersistenceAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFilePersistence(dir)
	if err != nil {
		t.Fatal(err)
	}

	// First server instance: Alice pushes.
	srv1 := httptest.NewServer(NewHub(DevAuth{}, store).Handler())
	alice := newClient(t, srv1, "acme:alice")
	if err := alice.engine.ApplyLocalSnapshot(snap(task("t1", "Persisted", "keep me"))); err != nil {
		t.Fatal(err)
	}
	alice.push()
	srv1.Close()

	// Fresh server instance, same data dir, fresh in-memory rooms.
	store2, _ := NewFilePersistence(dir)
	srv2 := httptest.NewServer(NewHub(DevAuth{}, store2).Handler())
	defer srv2.Close()

	bob := newClient(t, srv2, "acme:bob")
	bob.pull()
	if bob.tasks()["t1"]["title"] != "Persisted" {
		t.Fatalf("data lost across restart: %v", bob.tasks())
	}
}

// Missing/blank token is rejected.
func TestAuthRequired(t *testing.T) {
	srv := httptest.NewServer(NewHub(DevAuth{}, NewMemPersistence()).Handler())
	defer srv.Close()
	resp, code := rawPost(t, srv.URL+"/v1/pull", "", "{}")
	if code != 401 {
		t.Fatalf("want 401 without token, got %d (%s)", code, resp)
	}
}
