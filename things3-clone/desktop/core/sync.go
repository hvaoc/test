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

// Op is a single entity mutation exchanged with the cloud. It's the wire format
// for both push and pull.
type Op struct {
	Kind      string          `json:"kind"`
	ID        string          `json:"id"`
	Data      json.RawMessage `json:"data"`
	UpdatedAt int64           `json:"updatedAt"`
	Deleted   bool            `json:"deleted"`
	Device    string          `json:"device"`
}

// SyncAdapter is the seam between the local engine and "the cloud". Swapping the
// real backend in later means implementing this interface — nothing else in the
// app changes. Push uploads local ops; Pull returns every remote op after
// `sinceCursor`, plus the new cursor to persist.
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
	Applied  int    `json:"applied"`
	Skipped  int    `json:"skipped"` // pulled ops rejected by last-writer-wins
	Cursor   string `json:"cursor"`
	Snapshot string `json:"snapshot"` // fresh state JSON after applying remote ops
}

// SetAdapter installs the cloud adapter (nil disables sync).
func (s *Store) SetAdapter(a SyncAdapter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.adapter = a
}

// Sync runs one full cycle: push everything unsynced, then pull + merge remote
// ops (last-writer-wins on updated_at). Remote applies do NOT re-enter the
// oplog, so they don't echo back to the server. Returns a JSON SyncResult that
// includes the post-merge snapshot so the frontend can rehydrate in one call.
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
	rows, err := s.db.Query(`SELECT kind,id,data,updated_at,deleted FROM oplog WHERE synced=0 ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ops []Op
	for rows.Next() {
		var o Op
		var data string
		var del int
		if err := rows.Scan(&o.Kind, &o.ID, &data, &o.UpdatedAt, &del); err != nil {
			return nil, err
		}
		o.Data = json.RawMessage(data)
		o.Deleted = del == 1
		o.Device = s.device
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

// applyRemote merges pulled ops with last-writer-wins: a remote op wins only
// when its updated_at is >= the local entity's. Winners are written straight to
// the entities table (never the oplog — they came from the server).
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
		if o.Device == s.device {
			skipped++ // our own op echoed back
			continue
		}
		var curTs int64
		e := tx.QueryRow(`SELECT updated_at FROM entities WHERE kind=? AND id=?`, o.Kind, o.ID).Scan(&curTs)
		if e == nil && curTs > o.UpdatedAt {
			skipped++ // local copy is newer — keep it
			continue
		}
		del := 0
		if o.Deleted {
			del = 1
		}
		if _, e := tx.Exec(
			`INSERT INTO entities(kind,id,data,updated_at,deleted) VALUES(?,?,?,?,?)
			 ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, deleted=excluded.deleted`,
			o.Kind, o.ID, string(o.Data), o.UpdatedAt, del,
		); e != nil {
			return 0, 0, e
		}
		applied++
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
// merge behaviour is fully demoable with no server. Two Store instances pointed
// at the same mock file genuinely sync through it (append-only log + a
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
		return &mockLog{}, nil // corrupt/empty → start clean
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

// Pull returns every op after the cursor index. The cursor is just the count of
// ops the caller has already seen (append-only log ⇒ index is a valid cursor).
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
	// Deterministic order by updated_at, then id.
	sort.SliceStable(fresh, func(i, j int) bool {
		if fresh[i].UpdatedAt != fresh[j].UpdatedAt {
			return fresh[i].UpdatedAt < fresh[j].UpdatedAt
		}
		return fresh[i].ID < fresh[j].ID
	})
	return fresh, strconv.Itoa(len(l.Ops)), nil
}
