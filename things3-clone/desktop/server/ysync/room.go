package ysync

import (
	"bytes"
	"encoding/json"
	"sync"

	"github.com/reearth/ygo/crdt"
)

// Room is one tenant's authoritative document plus its realtime subscribers.
// crdt.Doc is not goroutine-safe, so every access goes through r.mu.
type Room struct {
	tenant string

	mu       sync.Mutex
	doc      *crdt.Doc
	ver      int64
	conns    map[int64]*conn            // live realtime connections
	presence map[int64]json.RawMessage  // last awareness state per connection
	nextConn int64
}

// conn is one realtime (WebSocket) connection's outbound message queue.
type conn struct {
	id  int64
	out chan []byte // pre-encoded JSON frames; non-blocking sends (drop if full)
}

func newRoom(tenant string, seed []byte) (*Room, error) {
	d := crdt.New()
	if len(seed) > 0 {
		if err := crdt.ApplyUpdateV1(d, seed, nil); err != nil {
			return nil, err
		}
	}
	return &Room{
		tenant:   tenant,
		doc:      d,
		conns:    map[int64]*conn{},
		presence: map[int64]json.RawMessage{},
	}, nil
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

// join registers a new realtime connection and returns it plus the current
// awareness states of everyone already present (so the newcomer sees them).
func (r *Room) join() (*conn, [][]byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id := r.nextConn
	r.nextConn++
	c := &conn{id: id, out: make(chan []byte, 16)}
	r.conns[id] = c
	var existing [][]byte
	for pid, st := range r.presence {
		existing = append(existing, presenceFrame(pid, st))
	}
	return c, existing
}

// leave removes a connection and tells everyone their presence is gone.
func (r *Room) leave(id int64) {
	r.mu.Lock()
	c, ok := r.conns[id]
	if ok {
		delete(r.conns, id)
		close(c.out)
	}
	_, hadPresence := r.presence[id]
	delete(r.presence, id)
	frame := leaveFrame(id)
	r.sendOthersLocked(id, frame)
	r.mu.Unlock()
	_ = hadPresence
}

// send delivers a frame to a connection, dropping it if the queue is full (a slow
// client must never block the room).
func send(c *conn, frame []byte) {
	select {
	case c.out <- frame:
	default:
	}
}

func (r *Room) sendOthersLocked(exceptID int64, frame []byte) {
	for id, c := range r.conns {
		if id != exceptID {
			send(c, frame)
		}
	}
}

// notify wakes every connection with the current data version so it pulls.
func (r *Room) notify() {
	r.mu.Lock()
	defer r.mu.Unlock()
	frame, _ := json.Marshal(map[string]any{"type": "changed", "version": r.ver})
	for _, c := range r.conns {
		send(c, frame)
	}
}

// setPresence records a connection's awareness state and broadcasts it to peers.
func (r *Room) setPresence(id int64, state json.RawMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.presence[id] = state
	r.sendOthersLocked(id, presenceFrame(id, state))
}

func presenceFrame(id int64, state json.RawMessage) []byte {
	b, _ := json.Marshal(map[string]any{"type": "presence", "from": id, "state": state})
	return b
}
func leaveFrame(id int64) []byte {
	b, _ := json.Marshal(map[string]any{"type": "presence-leave", "from": id})
	return b
}
