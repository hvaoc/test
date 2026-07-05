// Package ydstore is the native offline-first store for the Wails desktop app and
// the gomobile iOS/Android apps. It wraps the shared ygo engine (core/ydoc) with
// file persistence and state-vector sync against the ysync server — the same
// engine and the same wire protocol the browser uses, so all four platforms are
// one CRDT. It replaces the legacy SQLite register store (core) for the ygo
// migration; see docs/crdt-ygo.md.
package ydstore

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"things3-clone-desktop/core/ydoc"
)

const fileName = "store.ydoc.json"

type persisted struct {
	ClientID string `json:"clientID"` // decimal (Yjs ClientID is uint64)
	Snapshot string `json:"snapshot"` // base64 full-state Yjs update
}

type serverCfg struct{ url, token string }

// Store is one device's replica: an in-memory ygo document persisted to a JSON
// file, plus an optional sync-server connection.
type Store struct {
	mu     sync.Mutex
	dir    string
	engine *ydoc.Engine
	server serverCfg
	http   *http.Client
}

// Open loads the replica from dir (creating a fresh one if absent). The client id
// persists so the device keeps a stable identity across restarts.
func Open(dir string) (*Store, error) {
	s := &Store{dir: dir, http: &http.Client{Timeout: 30 * time.Second}}
	b, err := os.ReadFile(s.path())
	if os.IsNotExist(err) {
		s.engine = ydoc.New()
		return s, s.persistLocked()
	}
	if err != nil {
		return nil, err
	}
	var pd persisted
	if err := json.Unmarshal(b, &pd); err != nil {
		s.engine = ydoc.New() // corrupt -> fresh
		return s, nil
	}
	id, _ := strconv.ParseUint(pd.ClientID, 10, 64)
	snap, _ := base64.StdEncoding.DecodeString(pd.Snapshot)
	e, err := ydoc.Load(id, snap)
	if err != nil {
		return nil, err
	}
	s.engine = e
	return s, nil
}

func (s *Store) path() string { return filepath.Join(s.dir, fileName) }

// persistLocked writes the current document atomically. Caller holds s.mu.
func (s *Store) persistLocked() error {
	pd := persisted{
		ClientID: strconv.FormatUint(s.engine.ClientID(), 10),
		Snapshot: base64.StdEncoding.EncodeToString(s.engine.EncodeAll()),
	}
	b, err := json.Marshal(pd)
	if err != nil {
		return err
	}
	tmp := s.path() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path())
}

func (s *Store) HasData() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.engine.HasData(), nil
}

func (s *Store) LoadSnapshot() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.engine.Materialize()
}

func (s *Store) SaveSnapshot(state string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.engine.ApplyLocalSnapshot(state); err != nil {
		return err
	}
	return s.persistLocked()
}

// Reset wipes the local replica (backs the app's "Delete all data").
func (s *Store) Reset() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.engine = ydoc.New()
	return s.persistLocked()
}

// SetServer points sync at a server (url + bearer token). ClearServer disconnects.
func (s *Store) SetServer(url, token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.server = serverCfg{url: url, token: token}
}

func (s *Store) ClearServer() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.server = serverCfg{}
}

// SyncResult mirrors the web/native sync status returned to the UI.
type SyncResult struct {
	Adapter  string `json:"adapter"`
	Pushed   int64  `json:"pushed"`
	Pulled   int    `json:"pulled"`
	Applied  int    `json:"applied"`
	Skipped  int    `json:"skipped"`
	Version  int64  `json:"version"`
	Snapshot string `json:"snapshot"`
}

type pullResponse struct {
	Update  string `json:"update"`
	SV      string `json:"sv"`
	Version int64  `json:"version"`
}
type pushResponse struct {
	Version int64 `json:"version"`
}

// Sync runs one offline-first cycle against the server: pull what we're missing,
// then push exactly what the server is missing (state-vector exchange). With no
// server configured it is a no-op — the replica is fully usable offline.
func (s *Store) Sync() (string, error) {
	s.mu.Lock()
	server := s.server
	if server.url == "" || server.token == "" {
		s.mu.Unlock()
		return `{"adapter":"local"}`, nil
	}
	sv := s.engine.StateVector()
	s.mu.Unlock()

	base := strings.TrimRight(server.url, "/")

	var pull pullResponse
	if err := s.post(base+"/v1/pull", server.token, map[string]string{"sv": b64(sv)}, &pull); err != nil {
		return "", err
	}

	s.mu.Lock()
	applied := 0
	if pull.Update != "" {
		if u, err := unb64(pull.Update); err == nil && len(u) > 0 {
			if err := s.engine.ApplyUpdate(u); err == nil {
				applied = 1
			}
		}
	}
	serverSV, _ := unb64(pull.SV)
	diff, _ := s.engine.EncodeDiff(serverSV)
	s.mu.Unlock()

	var push pushResponse
	if err := s.post(base+"/v1/push", server.token, map[string]string{"update": b64(diff)}, &push); err != nil {
		return "", err
	}

	s.mu.Lock()
	_ = s.persistLocked()
	snap, _ := s.engine.Materialize()
	s.mu.Unlock()

	b, _ := json.Marshal(SyncResult{
		Adapter: "server", Pulled: applied, Applied: applied,
		Version: push.Version, Snapshot: snap,
	})
	return string(b), nil
}

// post sends a JSON body with a bearer token and decodes the JSON response.
func (s *Store) post(url, token string, body any, out any) error {
	buf, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
func unb64(s string) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(s)
}
