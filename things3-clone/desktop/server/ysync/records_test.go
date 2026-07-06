package ysync

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"things3-clone-desktop/core/record"
)

// recClient drives the REAL record engine (core/record) against the server's
// op-log endpoints — the exact structured-data sync path the apps use.
type recClient struct {
	t      *testing.T
	srv    *httptest.Server
	token  string
	store  *record.Store
	cursor int
}

func newRecClient(t *testing.T, srv *httptest.Server, token string) *recClient {
	s, err := record.Open(":memory:")
	if err != nil {
		t.Fatalf("open record store: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return &recClient{t: t, srv: srv, token: token, store: s}
}

func (c *recClient) post(path string, body any) map[string]any {
	c.t.Helper()
	b, _ := json.Marshal(body)
	resp, err := postJSON(c.srv.URL+path, c.token, b)
	if err != nil {
		c.t.Fatalf("%s: %v", path, err)
	}
	return resp
}

func (c *recClient) push() {
	c.t.Helper()
	pending, err := c.store.PendingOps(100000)
	if err != nil {
		c.t.Fatal(err)
	}
	if len(pending) == 0 {
		return
	}
	ops := make([]json.RawMessage, len(pending))
	seqs := make([]int64, len(pending))
	for i, so := range pending {
		b, _ := json.Marshal(so.Op)
		ops[i] = b
		seqs[i] = so.Seq
	}
	c.post("/v1/records/push", map[string]any{"ops": ops})
	if err := c.store.MarkSynced(seqs); err != nil {
		c.t.Fatal(err)
	}
}

func (c *recClient) pull() {
	c.t.Helper()
	resp := c.post("/v1/records/pull", map[string]any{"cursor": c.cursor})
	rawOps, _ := resp["ops"].([]any)
	ops := make([]record.Op, 0, len(rawOps))
	for _, ro := range rawOps {
		b, _ := json.Marshal(ro)
		var op record.Op
		if json.Unmarshal(b, &op) == nil {
			ops = append(ops, op)
		}
	}
	if len(ops) > 0 {
		if err := c.store.ApplyRemote(ops); err != nil {
			c.t.Fatal(err)
		}
	}
	if cur, ok := resp["cursor"].(float64); ok {
		c.cursor = int(cur)
	}
}

func (c *recClient) tasks() map[string]map[string]any {
	c.t.Helper()
	js, err := c.store.Materialize()
	if err != nil {
		c.t.Fatal(err)
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

func recState(tasks ...map[string]any) string {
	t := make([]any, len(tasks))
	for i, x := range tasks {
		t[i] = x
	}
	b, _ := json.Marshal(map[string]any{
		"areas": []any{}, "projects": []any{}, "headings": []any{},
		"tasks": t, "customViews": []any{}, "tags": []any{}, "settings": map[string]any{},
	})
	return string(b)
}

// Two tenant members converge through the record op-log: what Alice pushes, Bob
// pulls — and a concurrent field edit resolves by LWW (no ygo involved).
func TestRecordSync_SameTenant(t *testing.T) {
	srv := httptest.NewServer(NewHub(DevAuth{}, NewMemPersistence()).Handler())
	defer srv.Close()

	alice := newRecClient(t, srv, "acme:alice")
	bob := newRecClient(t, srv, "acme:bob")

	if err := alice.store.ApplyLocalSnapshot(recState(map[string]any{"id": "t1", "title": "Ship v1", "priority": float64(0)})); err != nil {
		t.Fatal(err)
	}
	alice.push()

	bob.pull()
	if bob.tasks()["t1"]["title"] != "Ship v1" {
		t.Fatalf("bob didn't receive alice's task: %v", bob.tasks())
	}

	// Concurrent edits to different fields converge.
	if err := alice.store.SetTaskField("t1", "title", "Ship v2"); err != nil {
		t.Fatal(err)
	}
	if err := bob.store.SetTaskField("t1", "priority", 3); err != nil {
		t.Fatal(err)
	}
	alice.push()
	bob.push()
	alice.pull()
	bob.pull()

	at, bt := alice.tasks()["t1"], bob.tasks()["t1"]
	if at["title"] != "Ship v2" || bt["title"] != "Ship v2" {
		t.Errorf("title edit lost: A=%v B=%v", at["title"], bt["title"])
	}
	if at["priority"] != float64(3) || bt["priority"] != float64(3) {
		t.Errorf("priority edit lost: A=%v B=%v", at["priority"], bt["priority"])
	}
	// Cursor advanced past the initial state.
	if alice.cursor == 0 {
		t.Errorf("cursor never advanced")
	}
}

// A different tenant must not see another tenant's record ops.
func TestRecordSync_TenantIsolation(t *testing.T) {
	srv := httptest.NewServer(NewHub(DevAuth{}, NewMemPersistence()).Handler())
	defer srv.Close()

	acme := newRecClient(t, srv, "acme:alice")
	globex := newRecClient(t, srv, "globex:carol")

	if err := acme.store.ApplyLocalSnapshot(recState(map[string]any{"id": "secret", "title": "Acme roadmap"})); err != nil {
		t.Fatal(err)
	}
	acme.push()

	globex.pull()
	if len(globex.tasks()) != 0 {
		t.Fatalf("cross-tenant leak: globex saw %v", globex.tasks())
	}
}

// The op-log survives a server restart (persistence).
func TestRecordSync_PersistAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFilePersistence(dir)
	if err != nil {
		t.Fatal(err)
	}
	srv1 := httptest.NewServer(NewHub(DevAuth{}, store).Handler())
	alice := newRecClient(t, srv1, "acme:alice")
	if err := alice.store.ApplyLocalSnapshot(recState(map[string]any{"id": "t1", "title": "Persisted"})); err != nil {
		t.Fatal(err)
	}
	alice.push()
	srv1.Close()

	store2, _ := NewFilePersistence(dir)
	srv2 := httptest.NewServer(NewHub(DevAuth{}, store2).Handler())
	defer srv2.Close()
	bob := newRecClient(t, srv2, "acme:bob")
	bob.pull()
	if bob.tasks()["t1"]["title"] != "Persisted" {
		t.Fatalf("record log lost across restart: %v", bob.tasks())
	}
}
