package ysync

import (
	"bytes"
	"sync"

	"github.com/reearth/ygo/crdt"
)

// Room is one tenant's authoritative document plus its realtime subscribers.
// crdt.Doc is not goroutine-safe, so every access goes through r.mu.
type Room struct {
	tenant string

	mu      sync.Mutex
	doc     *crdt.Doc
	ver     int64
	subs    map[int64]chan int64 // subscriber id -> coalescing nudge channel
	nextSub int64
}

func newRoom(tenant string, seed []byte) (*Room, error) {
	d := crdt.New()
	if len(seed) > 0 {
		if err := crdt.ApplyUpdateV1(d, seed, nil); err != nil {
			return nil, err
		}
	}
	return &Room{tenant: tenant, doc: d, subs: map[int64]chan int64{}}, nil
}

// Apply merges a client update. Returns the new version and whether anything was
// integrated (empty updates are a no-op and don't bump the version).
func (r *Room) Apply(update []byte) (int64, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(update) == 0 {
		return r.ver, false, nil
	}
	// A client often pushes a diff that turns out to contain nothing new (its view
	// already matched ours). Detect that via the state vector so we don't bump the
	// version, persist, or nudge teammates for a no-op.
	before := crdt.EncodeStateVectorV1(r.doc)
	if err := crdt.ApplyUpdateV1(r.doc, update, nil); err != nil {
		return r.ver, false, err
	}
	if bytes.Equal(before, crdt.EncodeStateVectorV1(r.doc)) {
		return r.ver, false, nil
	}
	r.ver++
	return r.ver, true, nil
}

// Diff returns everything the holder of clientSV is missing, and the current
// version. A nil/empty clientSV yields the full document state.
func (r *Room) Diff(clientSV []byte) ([]byte, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(clientSV) == 0 {
		return crdt.EncodeStateAsUpdateV1(r.doc, nil), r.ver, nil
	}
	sv, err := crdt.DecodeStateVectorV1(clientSV)
	if err != nil {
		return nil, r.ver, err
	}
	return crdt.EncodeStateAsUpdateV1(r.doc, sv), r.ver, nil
}

// Snapshot is the full merged state, for persistence.
func (r *Room) Snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return crdt.EncodeStateAsUpdateV1(r.doc, nil)
}

// StateVector is the room's wire-encoded state vector, so a client can compute
// exactly what the server is missing and push only that.
func (r *Room) StateVector() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return crdt.EncodeStateVectorV1(r.doc)
}

func (r *Room) subscribe() (int64, <-chan int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id := r.nextSub
	r.nextSub++
	ch := make(chan int64, 1)
	r.subs[id] = ch
	return id, ch
}

func (r *Room) unsubscribe(id int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ch, ok := r.subs[id]; ok {
		close(ch)
		delete(r.subs, id)
	}
}

// notify wakes every subscriber with the current version. Sends are non-blocking
// and coalesce (buffer of 1), so a slow client just gets the latest version on
// its next read rather than a backlog.
func (r *Room) notify() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ch := range r.subs {
		select {
		case ch <- r.ver:
		default:
		}
	}
}
