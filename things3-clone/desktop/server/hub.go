// Package server is the multi-user sync backend. It is deliberately a THIN,
// DUMB relay: it authenticates users and keeps a per-user append-only log of
// CRDT ops, serving them to that user's other devices and fanning out realtime
// nudges. It performs NO merging itself — every client (Go desktop/mobile, JS
// web) runs the identical CRDT engine, so convergence is guaranteed by the
// clients applying the same op set with deterministic HLC rules. That keeps the
// server trivially correct and lets any client work fully offline and reconcile
// on reconnect.
package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync"

	"things3-clone-desktop/core"
)

var (
	ErrExists   = errors.New("user already exists")
	ErrBadLogin = errors.New("invalid username or password")
	ErrNoAuth   = errors.New("unauthorized")
)

type user struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Salt string `json:"salt"`
	Hash string `json:"hash"` // sha256(salt + password); prototype — use argon2/bcrypt in prod
}

// Hub holds all users and their per-user op logs. Safe for concurrent use.
type Hub struct {
	mu        sync.Mutex
	users     map[string]*user            // by name
	usersByID map[string]*user            // by id
	tokens    map[string]string           // token -> userId
	logs      map[string][]core.Op        // userId -> append-only op log
	subs      map[string]map[int]chan int // userId -> subscriberID -> signal chan
	nextSub   int
	path      string // persistence file ("" = memory only)
}

func NewHub(path string) *Hub {
	h := &Hub{
		users:     map[string]*user{},
		usersByID: map[string]*user{},
		tokens:    map[string]string{},
		logs:      map[string][]core.Op{},
		subs:      map[string]map[int]chan int{},
		path:      path,
	}
	h.load()
	return h
}

// --- auth ---

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func hashPass(salt, pass string) string {
	sum := sha256.Sum256([]byte(salt + pass))
	return hex.EncodeToString(sum[:])
}

// Register creates a user and returns an auth token + user id.
func (h *Hub) Register(name, pass string) (token, userID string, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if name == "" || pass == "" {
		return "", "", ErrBadLogin
	}
	if _, ok := h.users[name]; ok {
		return "", "", ErrExists
	}
	u := &user{ID: "u-" + randHex(8), Name: name, Salt: randHex(8)}
	u.Hash = hashPass(u.Salt, pass)
	h.users[name] = u
	h.usersByID[u.ID] = u
	tok := h.issueLocked(u.ID)
	h.save()
	return tok, u.ID, nil
}

// Login verifies credentials and returns a fresh token + user id.
func (h *Hub) Login(name, pass string) (token, userID string, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u, ok := h.users[name]
	if !ok || u.Hash != hashPass(u.Salt, pass) {
		return "", "", ErrBadLogin
	}
	tok := h.issueLocked(u.ID)
	h.save()
	return tok, u.ID, nil
}

func (h *Hub) issueLocked(userID string) string {
	tok := randHex(16)
	h.tokens[tok] = userID
	return tok
}

// Auth resolves a bearer token to a user id.
func (h *Hub) Auth(token string) (userID string, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	id, ok := h.tokens[token]
	if !ok {
		return "", ErrNoAuth
	}
	return id, nil
}

// --- sync ---

// Push appends a user's ops to their log and nudges their other devices. Each
// user's data is fully isolated — a token only ever touches its own log.
func (h *Hub) Push(userID string, ops []core.Op) error {
	h.mu.Lock()
	h.logs[userID] = append(h.logs[userID], ops...)
	subs := h.subs[userID]
	chans := make([]chan int, 0, len(subs))
	for _, c := range subs {
		chans = append(chans, c)
	}
	n := len(h.logs[userID])
	h.save()
	h.mu.Unlock()

	// Fan out a realtime nudge (non-blocking) to connected devices.
	for _, c := range chans {
		select {
		case c <- n:
		default:
		}
	}
	return nil
}

// Pull returns a user's ops after the given cursor (an index into the log) and
// the new cursor. The cursor is just the count already seen — valid because the
// log is append-only.
func (h *Hub) Pull(userID string, cursor int) ([]core.Op, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	log := h.logs[userID]
	if cursor < 0 || cursor > len(log) {
		cursor = 0
	}
	out := append([]core.Op(nil), log[cursor:]...)
	return out, len(log)
}

// Subscribe registers a realtime listener for a user. Returns the signal channel
// and an unsubscribe func.
func (h *Hub) Subscribe(userID string) (<-chan int, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs[userID] == nil {
		h.subs[userID] = map[int]chan int{}
	}
	id := h.nextSub
	h.nextSub++
	ch := make(chan int, 1)
	h.subs[userID][id] = ch
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if m := h.subs[userID]; m != nil {
			delete(m, id)
		}
	}
}

// --- persistence (whole-hub JSON snapshot; fine for a prototype) ---

type persisted struct {
	Users  []*user              `json:"users"`
	Tokens map[string]string    `json:"tokens"`
	Logs   map[string][]core.Op `json:"logs"`
}

func (h *Hub) save() {
	if h.path == "" {
		return
	}
	p := persisted{Tokens: h.tokens, Logs: h.logs}
	for _, u := range h.usersByID {
		p.Users = append(p.Users, u)
	}
	if b, err := json.MarshalIndent(p, "", "  "); err == nil {
		_ = os.WriteFile(h.path, b, 0o600)
	}
}

func (h *Hub) load() {
	if h.path == "" {
		return
	}
	b, err := os.ReadFile(h.path)
	if err != nil {
		return
	}
	var p persisted
	if json.Unmarshal(b, &p) != nil {
		return
	}
	for _, u := range p.Users {
		h.users[u.Name] = u
		h.usersByID[u.ID] = u
	}
	if p.Tokens != nil {
		h.tokens = p.Tokens
	}
	if p.Logs != nil {
		h.logs = p.Logs
	}
}
