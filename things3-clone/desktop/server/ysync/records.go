package ysync

import (
	"encoding/json"
	"net/http"
	"sync"
)

// Record op-log transport: the structured-data delta stream (tasks, projects,
// areas, …) that replaces the monolithic shared ygo document. The server is a DUMB
// RELAY — it stores opaque per-op JSON in a per-tenant append-only log and answers
// "everything after cursor N". Convergence is the client's CRDT (field-level LWW +
// HLC in core/record); the server never parses an op. See docs/architecture-1m §4.
//
// Cursor = the log length. push appends and returns the new length; pull(cursor)
// returns log[cursor:] plus the new length. This is the same offset-cursor the
// legacy op-relay used, now tenant-scoped through the ysync auth/roomKey.

type recordLog struct {
	mu  sync.Mutex
	ops []json.RawMessage
}

// recordLogFor returns the per-scope op log, lazily loading it from persistence.
func (h *Hub) recordLogFor(scope string) *recordLog {
	h.recMu.Lock()
	defer h.recMu.Unlock()
	if rl, ok := h.recLogs[scope]; ok {
		return rl
	}
	rl := &recordLog{}
	if blob, err := h.store.Load(recStoreKey(scope)); err == nil && len(blob) > 0 {
		_ = json.Unmarshal(blob, &rl.ops)
	}
	h.recLogs[scope] = rl
	return rl
}

func recStoreKey(scope string) string { return "rec:" + scope }

// RecordPush appends ops to a scope's log and returns the new cursor (log length).
func (h *Hub) RecordPush(scope string, ops []json.RawMessage) (int, error) {
	rl := h.recordLogFor(scope)
	rl.mu.Lock()
	rl.ops = append(rl.ops, ops...)
	n := len(rl.ops)
	blob, _ := json.Marshal(rl.ops)
	rl.mu.Unlock()
	if err := h.store.Save(recStoreKey(scope), blob); err != nil {
		return n, err
	}
	return n, nil
}

// RecordPull returns every op after cursor plus the new cursor (log length).
func (h *Hub) RecordPull(scope string, cursor int) ([]json.RawMessage, int) {
	rl := h.recordLogFor(scope)
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if cursor < 0 {
		cursor = 0
	}
	if cursor > len(rl.ops) {
		cursor = len(rl.ops)
	}
	out := make([]json.RawMessage, len(rl.ops)-cursor)
	copy(out, rl.ops[cursor:])
	return out, len(rl.ops)
}

// ---- HTTP ----

type recordsPushReq struct {
	Ops []json.RawMessage `json:"ops"`
}
type recordsPushResp struct {
	Cursor int `json:"cursor"`
}

// handleRecordsPush appends the client's record ops to the tenant's op-log and
// nudges other members. Tenant write-role gated (structured data is shared).
func (h *Hub) handleRecordsPush(p Principal, w http.ResponseWriter, r *http.Request) {
	if !p.CanWrite() {
		writeErr(w, 403, "read-only: your role in this tenant cannot make changes")
		return
	}
	scope, _ := h.roomKey(p, r, scopeShared) // structured records live in the tenant scope
	var req recordsPushReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	cursor, err := h.RecordPush(scope, req.Ops)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if len(req.Ops) > 0 {
		h.notifyIfPresent(scope)
	}
	writeJSON(w, 200, recordsPushResp{Cursor: cursor})
}

type recordsPullReq struct {
	Cursor int `json:"cursor"`
}
type recordsPullResp struct {
	Ops    []json.RawMessage `json:"ops"`
	Cursor int               `json:"cursor"`
}

// handleRecordsPull returns the tenant's record ops after the client's cursor.
func (h *Hub) handleRecordsPull(p Principal, w http.ResponseWriter, r *http.Request) {
	scope, _ := h.roomKey(p, r, scopeShared)
	var req recordsPullReq
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	ops, cursor := h.RecordPull(scope, req.Cursor)
	writeJSON(w, 200, recordsPullResp{Ops: ops, Cursor: cursor})
}
