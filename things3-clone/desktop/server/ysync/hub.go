package ysync

import (
	"net/http"
	"sync"
)

// ScopeFunc maps an authenticated principal (and request) to a sync-scope key —
// the id of the document they read/write. The default is one document per tenant
// (the whole team collaborates on a shared database). To shard later (e.g. one
// document per project for memory bounds), swap this to include a project id from
// the request; nothing else changes.
type ScopeFunc func(p Principal, r *http.Request) string

// Hub owns the live rooms (one per scope), the persistence layer, and auth.
type Hub struct {
	auth  Authenticator
	store Persistence
	Scope ScopeFunc

	mu    sync.Mutex
	rooms map[string]*Room
}

// NewHub builds a hub. Pass DevAuth{} + a Persistence impl for Phase 1.
func NewHub(auth Authenticator, store Persistence) *Hub {
	return &Hub{
		auth:  auth,
		store: store,
		Scope: func(p Principal, _ *http.Request) string { return p.TenantID },
		rooms: map[string]*Room{},
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
