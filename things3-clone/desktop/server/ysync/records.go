package ysync

import (
	"encoding/json"
	"net/http"
)

// Record HTTP transport for the structured-data delta stream (tasks, projects,
// areas, …). Push appends/applies the client's ops; Pull returns everything after a
// cursor (cursor 0 = a full copy). The actual storage is a RecordStore (record_store.go):
// an append-only blob log by default, or a materialized Postgres register store.

type recordsPushReq struct {
	Ops []json.RawMessage `json:"ops"`
}
type recordsPushResp struct {
	Cursor int `json:"cursor"`
}

// handleRecordsPush applies the client's record ops to the tenant's record store and
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
	cursor, err := h.records.Push(scope, req.Ops)
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

// handleRecordsPull returns the tenant's record ops after the client's cursor (0 = a
// first-time full copy of the current state).
func (h *Hub) handleRecordsPull(p Principal, w http.ResponseWriter, r *http.Request) {
	scope, _ := h.roomKey(p, r, scopeShared)
	var req recordsPullReq
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	ops, cursor, err := h.records.Pull(scope, req.Cursor)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, recordsPullResp{Ops: ops, Cursor: cursor})
}
