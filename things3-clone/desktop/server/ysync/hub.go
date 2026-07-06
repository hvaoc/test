package ysync

import (
	"net/http"
	"strings"
	"sync"
)

// Client-side scope hints (docs/architecture-1m.md §2.2). They travel on the
// request (push/pull body, stream query) and are mapped to a room key by roomKey.
const (
	scopeShared     = "shared"
	scopeSettings   = "settings"
	scopeNotePrefix = "note:"
)

// ScopeFunc maps an authenticated principal (and request) to a sync-scope key —
// the id of the document they read/write. The default is one document per tenant
// (the whole team collaborates on a shared database). To shard later (e.g. one
// document per project for memory bounds), swap this to include a project id from
// the request; nothing else changes.
type ScopeFunc func(p Principal, r *http.Request) string

// Hub owns the live rooms (one per scope), the persistence layer, and auth. It
// serves two transports over the same tenant scoping + auth: ygo state-vector rooms
// (notes, settings) and per-tenant record OP-LOGS (the structured-data delta stream
// that replaces the monolithic shared ygo doc — docs/architecture-1m §3-4).
type Hub struct {
	auth  Authenticator
	store Persistence
	Scope ScopeFunc

	mu    sync.Mutex
	rooms map[string]*Room

	recMu   sync.Mutex
	recLogs map[string]*recordLog // scope -> append-only op log
}

// NewHub builds a hub. Pass DevAuth{} + a Persistence impl for Phase 1.
func NewHub(auth Authenticator, store Persistence) *Hub {
	return &Hub{
		auth:    auth,
		store:   store,
		Scope:   func(p Principal, _ *http.Request) string { return p.TenantID },
		rooms:   map[string]*Room{},
		recLogs: map[string]*recordLog{},
	}
}

// notifyIfPresent nudges a scope's live stream connections (if any) so they pull.
// Used after a record push, reusing the ygo room's WS fan-out.
func (h *Hub) notifyIfPresent(scope string) {
	h.mu.Lock()
	r, ok := h.rooms[scope]
	h.mu.Unlock()
	if ok {
		r.notify()
	}
}

// roomKey maps a client's scope hint onto a room key, routing each of the three
// scopes to the right audience:
//
//   - shared / "" -> the tenant document (h.Scope; the whole team). Unchanged key,
//     so pre-scopes persisted data still loads.
//   - settings     -> "u:<userId>" — the requesting user's PRIVATE room. Keyed by
//     the authenticated token's UserID, so no other user can ever reach it: this is
//     what keeps per-user settings from syncing to teammates.
//   - note:<taskId> -> "t:<tenantId>:note:<taskId>" — one room per task's notes,
//     shared among tenant members who open that task (on-demand).
//
// isPrivate reports whether the scope is the user's own room (settings), which any
// authenticated user may write regardless of their tenant write-role.
func (h *Hub) roomKey(p Principal, r *http.Request, clientScope string) (key string, isPrivate bool) {
	switch {
	case clientScope == "" || clientScope == scopeShared:
		return h.Scope(p, r), false
	case clientScope == scopeSettings:
		return "u:" + p.UserID, true
	case strings.HasPrefix(clientScope, scopeNotePrefix):
		return "t:" + p.TenantID + ":" + clientScope, false
	default:
		return h.Scope(p, r), false
	}
}

// room returns the live room for a scope, lazily loading its persisted snapshot.
func (h *Hub) room(scope string) (*Room, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[scope]; ok {
		return r, nil
	}
	seed, err := h.store.Load(scope)
	if err != nil {
		return nil, err
	}
	r, err := newRoom(scope, seed)
	if err != nil {
		return nil, err
	}
	h.rooms[scope] = r
	return r, nil
}

// Push merges a client update into the scope's document, persists the new state,
// and nudges other connected clients. Returns the new version.
func (h *Hub) Push(scope string, update []byte) (int64, error) {
	r, err := h.room(scope)
	if err != nil {
		return 0, err
	}
	ver, changed, err := r.Apply(update)
	if err != nil {
		return ver, err
	}
	if changed {
		if err := h.store.Save(scope, r.Snapshot()); err != nil {
			return ver, err
		}
		r.notify()
	}
	return ver, nil
}

// Pull returns everything the client (identified by its state vector) is missing,
// plus the server's own state vector so the client can push back exactly what the
// server lacks.
func (h *Hub) Pull(scope string, clientSV []byte) (update []byte, serverSV []byte, version int64, err error) {
	r, err := h.room(scope)
	if err != nil {
		return nil, nil, 0, err
	}
	update, version, err = r.Diff(clientSV)
	if err != nil {
		return nil, nil, version, err
	}
	return update, r.StateVector(), version, nil
}
