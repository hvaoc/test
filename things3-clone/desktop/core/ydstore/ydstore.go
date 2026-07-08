// Package ydstore is the native offline-first store for the Wails desktop app and
// the gomobile iOS/Android apps. It wraps the shared ygo engine (core/ydoc) with
// file persistence and state-vector sync against the ysync server — the same
// engine and the same wire protocol the browser uses, so all four platforms are
// one CRDT.
//
// Sync + persistence are PER-SCOPE (docs/architecture-1m.md §2.2): the shared and
// settings scopes sync every cycle; a task's note scope syncs only while that task
// is "open" (SyncNote/CloseNote) — the on-demand notes model. Each scope is routed
// to its own server room, so per-user settings never reach teammates. See
// docs/crdt-ygo.md.
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
	ClientID string            `json:"clientID"`           // decimal (Yjs ClientID is uint64)
	Scopes   map[string]string `json:"scopes,omitempty"`   // scope -> base64 full-state blob
	Snapshot string            `json:"snapshot,omitempty"` // legacy single-doc blob (pre-scopes)
}

type serverCfg struct{ url, token string }

// Store is one device's replica: an in-memory ygo engine (three scopes) persisted
// to a JSON file, plus an optional sync-server connection.
type Store struct {
	mu        sync.Mutex
	dir       string
	engine    *ydoc.Engine
	server    serverCfg
	openNotes map[string]bool // taskIds whose note scope is currently synced on demand
	http      *http.Client
}

// Open loads the replica from dir (creating a fresh one if absent). The client id
// persists so the device keeps a stable identity across restarts. A legacy
// single-doc file is migrated to scopes on first open.
func Open(dir string) (*Store, error) {
	s := &Store{dir: dir, openNotes: map[string]bool{}, http: &http.Client{Timeout: 30 * time.Second}}
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
	s.engine = ydoc.NewWithClientID(id)

	if len(pd.Scopes) > 0 {
		for scope, blob := range pd.Scopes {
			snap, _ := base64.StdEncoding.DecodeString(blob)
			if err := s.engine.LoadScope(scope, snap); err != nil {
				return nil, err
			}
		}
		return s, nil
	}
	if pd.Snapshot != "" {
		// Legacy single-doc blob: load into shared, split settings + notes out.
		snap, _ := base64.StdEncoding.DecodeString(pd.Snapshot)
		if err := s.engine.LoadScope(ydoc.ScopeShared, snap); err != nil {
			return nil, err
		}
		s.engine.MigrateLegacy()
		return s, s.persistLocked() // rewrite in the new scoped format
	}
	return s, nil
}

func (s *Store) path() string { return filepath.Join(s.dir, fileName) }

// persistLocked writes every live scope's document atomically. Caller holds s.mu.
func (s *Store) persistLocked() error {
	scopes := map[string]string{}
	for _, scope := range s.engine.Scopes() {
		blob, err := s.engine.EncodeAll(scope)
		if err != nil {
			return err
		}
		scopes[scope] = base64.StdEncoding.EncodeToString(blob)
	}
	pd := persisted{
		ClientID: strconv.FormatUint(s.engine.ClientID(), 10),
		Scopes:   scopes,
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

// SaveAux persists ONLY the ygo-owned parts of the whole-state snapshot — settings
// (per-user) and each open task's notes — leaving structured entities to the record
// engine. The coordinator uses this so ygo never re-materializes task data. See
// ydoc.Engine.ApplyLocalSnapshotAux.
func (s *Store) SaveAux(state string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.engine.ApplyLocalSnapshotAux(state); err != nil {
		return err
	}
	return s.persistLocked()
}

// Settings returns the current settings map (the per-user ygo scope), for the
// coordinator to overlay onto the record engine's structured materialization.
func (s *Store) Settings() (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.engine.Settings(), nil
}

// NoteText returns a task's note body from its (loaded) per-task ygo doc, or "".
func (s *Store) NoteText(taskID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.engine.NoteText(taskID)
}

// OpenNotes lists the task ids whose note scope is currently marked for on-demand
// sync, so the coordinator can overlay their note text at materialize time.
func (s *Store) OpenNotes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0, len(s.openNotes))
	for id := range s.openNotes {
		ids = append(ids, id)
	}
	return ids
}

// Reset wipes the local replica (backs the app's "Delete all data").
func (s *Store) Reset() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.engine = ydoc.New()
	s.openNotes = map[string]bool{}
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

// OpenNote marks a task's note scope for on-demand sync (call when its detail view
// opens); CloseNote stops syncing it (call on close). Ongoing Sync cycles include
// every open note scope.
func (s *Store) OpenNote(taskID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if taskID != "" {
		s.openNotes[taskID] = true
	}
}

func (s *Store) CloseNote(taskID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.openNotes, taskID)
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

// Sync runs one offline-first cycle: sync the shared + settings scopes, plus any
// open note scopes. With no server configured it is a no-op.
func (s *Store) Sync() (string, error) {
	s.mu.Lock()
	server := s.server
	if server.url == "" || server.token == "" {
		s.mu.Unlock()
		return `{"adapter":"local"}`, nil
	}
	scopes := []string{ydoc.ScopeShared, ydoc.ScopeSettings}
	for id := range s.openNotes {
		scopes = append(scopes, ydoc.NoteScope(id))
	}
	s.mu.Unlock()

	base := strings.TrimRight(server.url, "/")
	applied := 0
	var version int64
	for _, scope := range scopes {
		a, v, err := s.syncScope(base, server.token, scope)
		if err != nil {
			return "", err
		}
		applied += a
		if scope == ydoc.ScopeShared {
			version = v
		}
	}

	s.mu.Lock()
	_ = s.persistLocked()
	snap, _ := s.engine.Materialize()
	s.mu.Unlock()

	b, _ := json.Marshal(SyncResult{
		Adapter: "server", Pulled: applied, Applied: applied,
		Version: version, Snapshot: snap,
	})
	return string(b), nil
}

// SyncAux runs one offline-first cycle for the ygo-owned scopes ONLY: settings (per
// user) plus any open note scopes — never the shared scope, whose structured data now
// syncs through the record op-log. The coordinator uses this so ygo carries no task
// data over the wire. Returns the number of scopes that applied a remote update. With
// no server configured it is a no-op.
func (s *Store) SyncAux() (int, error) {
	s.mu.Lock()
	server := s.server
	if server.url == "" || server.token == "" {
		s.mu.Unlock()
		return 0, nil
	}
	scopes := []string{ydoc.ScopeSettings}
	for id := range s.openNotes {
		scopes = append(scopes, ydoc.NoteScope(id))
	}
	s.mu.Unlock()

	base := strings.TrimRight(server.url, "/")
	applied := 0
	for _, scope := range scopes {
		a, _, err := s.syncScope(base, server.token, scope)
		if err != nil {
			return applied, err
		}
		applied += a
	}
	s.mu.Lock()
	_ = s.persistLocked()
	s.mu.Unlock()
	return applied, nil
}

// SyncNote syncs a single task's note scope on demand (and marks it open so later
// Sync cycles keep it fresh). Returns the merged whole-state snapshot so the UI can
// refresh the note. With no server it just marks the note open and returns state.
func (s *Store) SyncNote(taskID string) (string, error) {
	s.mu.Lock()
	if taskID != "" {
		s.openNotes[taskID] = true
	}
	server := s.server
	s.mu.Unlock()

	if taskID != "" && server.url != "" && server.token != "" {
		base := strings.TrimRight(server.url, "/")
		if _, _, err := s.syncScope(base, server.token, ydoc.NoteScope(taskID)); err != nil {
			return "", err
		}
		s.mu.Lock()
		_ = s.persistLocked()
		s.mu.Unlock()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	return s.engine.Materialize()
}

// syncScope runs one pull+push state-vector exchange for a single scope. Network
// I/O happens outside the lock; engine ops inside it.
func (s *Store) syncScope(base, token, scope string) (applied int, version int64, err error) {
	s.mu.Lock()
	sv, err := s.engine.StateVector(scope)
	s.mu.Unlock()
	if err != nil {
		return 0, 0, err
	}

	var pull pullResponse
	if err := s.post(base+"/v1/pull", token, map[string]string{"scope": scope, "sv": b64(sv)}, &pull); err != nil {
		return 0, 0, err
	}

	s.mu.Lock()
	if pull.Update != "" {
		if u, e := unb64(pull.Update); e == nil && len(u) > 0 {
			if s.engine.ApplyUpdate(scope, u) == nil {
				applied = 1
			}
		}
	}
	serverSV, _ := unb64(pull.SV)
	diff, _ := s.engine.EncodeDiff(scope, serverSV)
	s.mu.Unlock()

	var push pushResponse
	if err := s.post(base+"/v1/push", token, map[string]string{"scope": scope, "update": b64(diff)}, &push); err != nil {
		return applied, 0, err
	}
	return applied, push.Version, nil
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
