package coordinator

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"things3-clone-desktop/core/record"
)

// fakeRecordServer is a minimal stand-in for the ysync record endpoints that forces the
// cursorExpired branch: the FIRST incremental pull (cursor > 0) returns cursorExpired,
// and the follow-up full pull (cursor 0) returns the "current copy" the test sets. The
// materialized Postgres store is the only real store that expires cursors, and it needs
// a live database — this fake exercises the client-side recordFullReload logic instead.
type fakeRecordServer struct {
	mu       sync.Mutex
	copyOps  []json.RawMessage // the server's current whole-state copy (returned at cursor 0)
	pushed   [][]json.RawMessage
	expireOn bool            // when true, an incremental pull (cursor>0) returns cursorExpired once
	dropIDs  map[string]bool // entity ids the server "deleted" concurrently — pushed ops for them are ignored
}

func (f *fakeRecordServer) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/records/push", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Ops []json.RawMessage `json:"ops"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.pushed = append(f.pushed, req.Ops)
		// Materialize pushed ops into the server's current copy (a real server would),
		// EXCEPT ops targeting entities the server deleted concurrently (dropIDs) — those
		// stay absent, modelling a delete that raced our push.
		for _, raw := range req.Ops {
			var op record.Op
			if json.Unmarshal(raw, &op) == nil && f.dropIDs[op.ID] {
				continue
			}
			f.copyOps = append(f.copyOps, raw)
		}
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"cursor": 1})
	})
	mux.HandleFunc("/v1/records/pull", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Cursor int `json:"cursor"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		defer f.mu.Unlock()
		if req.Cursor > 0 && f.expireOn {
			f.expireOn = false
			_ = json.NewEncoder(w).Encode(map[string]any{"cursorExpired": true})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ops": f.copyOps, "cursor": 42})
	})
	// Minimal ygo-scope stubs so SyncAux (settings) doesn't error on this fake server.
	mux.HandleFunc("/v1/pull", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"update": "", "sv": "", "version": 0})
	})
	mux.HandleFunc("/v1/push", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"version": 0})
	})
	return mux
}

// presenceOp / fieldOp build wire ops matching record.Op's json tags {t,k,i,f,v,p,h}.
func makeOps(t *testing.T, tasks map[string]string) []json.RawMessage {
	t.Helper()
	// Build a real record.Store, apply a snapshot, and read its pending ops — the
	// simplest way to get correctly-shaped ops (with HLCs) for the "server copy".
	s, err := record.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	arr := make([]any, 0, len(tasks))
	for id, title := range tasks {
		arr = append(arr, map[string]any{"id": id, "title": title, "notes": "", "tags": []any{}})
	}
	state, _ := json.Marshal(map[string]any{
		"areas": []any{}, "projects": []any{}, "headings": []any{},
		"tasks": arr, "customViews": []any{}, "tags": []any{}, "settings": map[string]any{},
	})
	if err := s.ApplyLocalSnapshot(string(state)); err != nil {
		t.Fatal(err)
	}
	pending, err := s.PendingOps(0)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]json.RawMessage, len(pending))
	for i, so := range pending {
		b, _ := json.Marshal(so.Op)
		out[i] = b
	}
	return out
}

// A cursorExpired pull triggers a full reload: local state is wiped and rebuilt from the
// server's current copy. An entity the copy omits (a delete that happened while we were
// gone) disappears locally; our own offline creation survives (pushed + re-applied).
func TestCursorExpiredFullReload(t *testing.T) {
	fake := &fakeRecordServer{
		copyOps:  makeOps(t, map[string]string{"srv1": "Server task"}),
		expireOn: true,
		dropIDs:  map[string]bool{"stale": true}, // server deleted "stale" concurrently
	}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	c := openCoord(t)
	c.SetServer(srv.URL, "acme:alice")

	// Local state before the expiry: a stale task the server no longer has, plus our own
	// fresh offline creation.
	if err := c.SaveSnapshot(snap(nil,
		task("stale", "Was deleted on server", nil),
		task("mine", "My offline task", nil),
	)); err != nil {
		t.Fatal(err)
	}
	// Give the store a non-zero cursor so the next pull is treated as incremental.
	if err := c.Record().SetCursor("5"); err != nil {
		t.Fatal(err)
	}

	if _, err := c.Sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}

	m := tasksOf(t, c)
	// The server copy's task is present.
	if m["srv1"]["title"] != "Server task" {
		t.Fatalf("full reload did not import the server copy: %v", m)
	}
	// The stale (server-deleted) task is gone.
	if _, ok := m["stale"]; ok {
		t.Fatalf("stale task survived full reload (should be dropped): %v", m)
	}
	// Our own offline creation survived.
	if m["mine"]["title"] != "My offline task" {
		t.Fatalf("own offline creation lost across full reload: %v", m)
	}
	// Cursor was reset to the copy's high-water.
	cur, _ := c.Record().Cursor()
	if cur != "42" {
		t.Fatalf("cursor after full reload = %q, want 42", cur)
	}
}
