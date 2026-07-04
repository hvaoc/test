package core

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
)

// Op is a single CRDT mutation exchanged with the cloud — the wire format for
// both push and pull. One op targets exactly one register: a scalar field
// ("field"), a set element ("set"), or an entity's existence ("presence"). Each
// carries the HLC stamp that decides conflicts.
type Op struct {
	Type    string          `json:"t"` // "field" | "set" | "presence"
	Kind    string          `json:"k"`
	ID      string          `json:"i"`
	Field   string          `json:"f,omitempty"`
	Elem    string          `json:"e,omitempty"`
	Value   json.RawMessage `json:"v,omitempty"`
	Present bool            `json:"p,omitempty"`
	Wall    int64           `json:"w"`
	Ctr     int64           `json:"c"`
	Node    string          `json:"n"`
}

func (o Op) hlc() HLC      { return HLC{Wall: o.Wall, Ctr: o.Ctr, Node: o.Node} }
func (o *Op) setHLC(h HLC) { o.Wall, o.Ctr, o.Node = h.Wall, h.Ctr, h.Node }

// SyncAdapter is the seam between the local engine and "the cloud". Swapping the
// real backend in later means implementing this interface — nothing else in the
// app changes.
type SyncAdapter interface {
	Push(ops []Op) error
	Pull(sinceCursor string) (ops []Op, nextCursor string, err error)
	Name() string
}

// SyncResult is returned to the UI so it can show status.
type SyncResult struct {
	Adapter  string `json:"adapter"`
	Pushed   int    `json:"pushed"`
	Pulled   int    `json:"pulled"`
	Applied  int    `json:"applied"` // remote ops that won (were newer)
	Skipped  int    `json:"skipped"` // remote ops rejected by a newer local value
	Cursor   string `json:"cursor"`
	Snapshot string `json:"snapshot"` // fresh merged state after applying remote ops
}

// SetAdapter installs the cloud adapter (nil disables sync).
func (s *Store) SetAdapter(a SyncAdapter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.adapter = a
}

// Sync runs one full cycle: push unsynced local ops, then pull remote ops and
// merge them. Because every op is a HLC-stamped CRDT mutation, merge is
// deterministic and order-independent — every replica converges to the same
// state no matter who wrote what, when, or in which order ops arrive.
func (s *Store) Sync() (string, error) {
	s.mu.Lock()
	adapter := s.adapter
	s.mu.Unlock()
	if adapter == nil {
		res, _ := json.Marshal(SyncResult{Adapter: "none"})
		return string(res), nil
	}

	res := SyncResult{Adapter: adapter.Name()}

	// ---- Push ----
	pending, err := s.pendingOps()
	if err != nil {
		return "", err
	}
	if len(pending) > 0 {
		if err := adapter.Push(pending); err != nil {
			return "", err
		}
		if err := s.markSynced(); err != nil {
			return "", err
		}
		res.Pushed = len(pending)
	}

	// ---- Pull + merge ----
	cursor, _ := s.metaGet("pull_cursor")
	remote, next, err := adapter.Pull(cursor)
	if err != nil {
		return "", err
	}
	res.Pulled = len(remote)
	applied, skipped, err := s.applyRemote(remote)
	if err != nil {
		return "", err
	}
	res.Applied, res.Skipped = applied, skipped
	if next != "" && next != cursor {
		if err := s.metaSet("pull_cursor", next); err != nil {
			return "", err
		}
	}
	res.Cursor = next

	snap, err := s.LoadSnapshot()
	if err != nil {
		return "", err
	}
	res.Snapshot = snap

	b, err := json.Marshal(res)
	return string(b), err
}

func (s *Store) pendingOps() ([]Op, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT optype,kind,id,field,elem,value,present,hlc FROM oplog WHERE synced=0 ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ops []Op
	for rows.Next() {
		var o Op
		var value, hlc string
		var present int
		if err := rows.Scan(&o.Type, &o.Kind, &o.ID, &o.Field, &o.Elem, &value, &present, &hlc); err != nil {
			return nil, err
		}
		if value != "" {
			o.Value = json.RawMessage(value)
		}
		o.Present = present == 1
		o.setHLC(parseHLC(hlc))
		ops = append(ops, o)
	}
	return ops, rows.Err()
}

func (s *Store) markSynced() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE oplog SET synced=1 WHERE synced=0`)
	return err
}

// applyRemote merges pulled ops. Each op is applied iff its HLC beats the local
// register's (last-writer-wins per field / set element / presence). Winners are
// written straight to the CRDT tables — never the oplog — so they don't echo
// back to the cloud. The local clock witnesses every remote HLC so subsequent
// local edits are causally ordered after them.
func (s *Store) applyRemote(ops []Op) (applied, skipped int, err error) {
	if len(ops) == 0 {
		return 0, 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback() //nolint:errcheck

	for _, o := range ops {
		s.clk.witness(o.hlc())
		if o.Node == s.device {
			skipped++ // our own op echoed back by the cloud log
			continue
		}
		ok, e := applyOpTx(tx, o, false)
		if e != nil {
			return 0, 0, e
		}
		if ok {
			applied++
		} else {
			skipped++
		}
	}
	if err := s.saveClockTx(tx); err != nil {
		return 0, 0, err
	}
	return applied, skipped, tx.Commit()
}

func (s *Store) metaGet(key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key=?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return v, err
}

func (s *Store) metaSet(key, value string) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)`, key, value)
	return err
}

// ---------------------------------------------------------------------------
// MockAdapter — a file-backed stand-in for the cloud so the offline-first +
// auto-merge behaviour is fully demoable with no server. Two Stores pointed at
// the same mock file genuinely converge through it (append-only op log + a
// monotonic cursor). Replace with a real HTTP/WebSocket adapter later.
// ---------------------------------------------------------------------------

type MockAdapter struct {
	mu   sync.Mutex
	path string
}

func NewMockAdapter(dir string) *MockAdapter {
	return &MockAdapter{path: filepath.Join(dir, "mock-cloud.json")}
}

func (m *MockAdapter) Name() string { return "mock" }

type mockLog struct {
	Ops []Op `json:"ops"`
}

func (m *MockAdapter) load() (*mockLog, error) {
	b, err := os.ReadFile(m.path)
	if os.IsNotExist(err) {
		return &mockLog{}, nil
	}
	if err != nil {
		return nil, err
	}
	var l mockLog
	if err := json.Unmarshal(b, &l); err != nil {
		return &mockLog{}, nil
	}
	return &l, nil
}

func (m *MockAdapter) save(l *mockLog) error {
	b, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.path, b, 0o644)
}

func (m *MockAdapter) Push(ops []Op) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, err := m.load()
	if err != nil {
		return err
	}
	l.Ops = append(l.Ops, ops...)
	return m.save(l)
}

// Pull returns every op after the cursor (an index into the append-only log),
// HLC-ordered for deterministic application.
func (m *MockAdapter) Pull(sinceCursor string) ([]Op, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, err := m.load()
	if err != nil {
		return nil, sinceCursor, err
	}
	from := 0
	if sinceCursor != "" {
		if n, e := strconv.Atoi(sinceCursor); e == nil {
			from = n
		}
	}
	if from > len(l.Ops) {
		from = len(l.Ops)
	}
	fresh := append([]Op(nil), l.Ops[from:]...)
	sort.SliceStable(fresh, func(i, j int) bool { return fresh[i].hlc().Compare(fresh[j].hlc()) < 0 })
	return fresh, strconv.Itoa(len(l.Ops)), nil
}
