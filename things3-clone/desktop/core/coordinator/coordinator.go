// Package coordinator is the native (Wails desktop + gomobile iOS/Android) analog of
// the web coordinator in src/store/backend.js: it routes STRUCTURED data (tasks,
// projects, areas, headings, customViews, tags) through the record engine's
// field-level CRDT op-log (core/record) while keeping per-user settings and per-task
// notes on the ygo layer (core/ydstore -> core/ydoc).
//
// One Coordinator owns exactly ONE record.Store, so the snapshot-save path and the
// query pass-throughs (QueryList/QueryTasks/…) share state — fixing the old mobile bug
// where saves went to ydstore (ygo) but queries hit a separate record.Store.
//
// Sync splits by data kind (mirroring backend.js coordinatorServerSync):
//   - structured -> record op-log: push pending ops to /v1/records/push, MarkSynced,
//     then pull /v1/records/pull since our cursor -> ApplyRemote + SetCursor. A
//     `cursorExpired` pull (the server GC'd past our cursor) triggers a full reload:
//     pull from cursor 0, keep pending ops that are own-creations or target a
//     still-live entity, drop edits to vanished entities, wipe local, rebuild.
//   - settings + open notes -> ygo scopes via ydstore.SyncAux (NEVER the shared scope).
package coordinator

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"things3-clone-desktop/core/record"
	"things3-clone-desktop/core/ydstore"
)

const recordFileName = "records.db"

// Coordinator composes the record engine (structured, source of truth) with the ygo
// layer (settings + notes). It is safe for concurrent use.
type Coordinator struct {
	mu      sync.Mutex
	dir     string
	recPath string
	rec     *record.Store
	ygo     *ydstore.Store
	server  serverCfg
	http    *http.Client
}

type serverCfg struct{ url, token string }

// Open opens (or creates) both stores under dir: the record SQLite database at
// dir/records.db and the ygo replica (its own file). Call once at app launch.
func Open(dir string) (*Coordinator, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	recPath := filepath.Join(dir, recordFileName)
	rec, err := record.Open(recPath)
	if err != nil {
		return nil, err
	}
	ygo, err := ydstore.Open(dir)
	if err != nil {
		_ = rec.Close()
		return nil, err
	}
	return &Coordinator{
		dir:     dir,
		recPath: recPath,
		rec:     rec,
		ygo:     ygo,
		http:    &http.Client{Timeout: 30 * time.Second},
	}, nil
}

// Record exposes the underlying record.Store so mobile's Record* query bindings can
// share the coordinator's single store (rather than opening a second one).
func (c *Coordinator) Record() *record.Store {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.rec
}

// SetServer points both layers at a sync server; ClearServer disconnects.
func (c *Coordinator) SetServer(url, token string) {
	c.mu.Lock()
	c.server = serverCfg{url: url, token: token}
	c.mu.Unlock()
	c.ygo.SetServer(url, token)
}

func (c *Coordinator) ClearServer() {
	c.mu.Lock()
	c.server = serverCfg{}
	c.mu.Unlock()
	c.ygo.ClearServer()
}

// HasData reports whether either layer holds anything (structured tasks or settings).
func (c *Coordinator) HasData() (bool, error) {
	c.mu.Lock()
	rec := c.rec
	c.mu.Unlock()
	if has, err := rec.HasData(); err != nil {
		return false, err
	} else if has {
		return true, nil
	}
	settings, err := c.ygo.Settings()
	if err != nil {
		return false, err
	}
	return len(settings) > 0, nil
}

// OpenNote / CloseNote mark a task's note scope for on-demand sync (open its detail
// view / close it).
func (c *Coordinator) OpenNote(taskID string)  { c.ygo.OpenNote(taskID) }
func (c *Coordinator) CloseNote(taskID string) { c.ygo.CloseNote(taskID) }

// Reset wipes all local data on both layers.
func (c *Coordinator) Reset() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.wipeRecordLocked(); err != nil {
		return err
	}
	return c.ygo.Reset()
}

// wipeRecordLocked closes, deletes, and reopens the record database (record.Store has
// no in-place wipe). Caller holds c.mu. Removes the WAL/SHM sidecar files too.
func (c *Coordinator) wipeRecordLocked() error {
	if c.rec != nil {
		_ = c.rec.Close()
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(c.recPath + suffix); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	rec, err := record.Open(c.recPath)
	if err != nil {
		return err
	}
	c.rec = rec
	return nil
}

// LoadSnapshot merges the two layers into the whole-state snapshot the frontend
// expects (mirroring backend.js coordinatorMaterialize): structured from the record
// engine, with settings and open-task notes overlaid from ygo. Returns "" when both
// layers are empty (so the frontend falls back to its seed data).
func (c *Coordinator) LoadSnapshot() (string, error) {
	c.mu.Lock()
	rec := c.rec
	c.mu.Unlock()

	hasStructured, err := rec.HasData()
	if err != nil {
		return "", err
	}
	settings, err := c.ygo.Settings()
	if err != nil {
		return "", err
	}
	if !hasStructured && len(settings) == 0 {
		return "", nil
	}
	return c.materializeLocked(rec, settings)
}

// materializeLocked builds the merged snapshot. settings is the ygo settings map.
func (c *Coordinator) materializeLocked(rec *record.Store, settings map[string]any) (string, error) {
	structJSON, err := rec.Materialize()
	if err != nil {
		return "", err
	}
	var state map[string]any
	if err := json.Unmarshal([]byte(structJSON), &state); err != nil {
		return "", err
	}
	if settings == nil {
		settings = map[string]any{}
	}
	state["settings"] = settings

	// Overlay notes for currently-open tasks (on-demand; the rest stay "").
	open := map[string]bool{}
	for _, id := range c.ygo.OpenNotes() {
		open[id] = true
	}
	if len(open) > 0 {
		if tasks, ok := state["tasks"].([]any); ok {
			for _, t := range tasks {
				tm, ok := t.(map[string]any)
				if !ok {
					continue
				}
				id, _ := tm["id"].(string)
				if open[id] {
					if note := c.ygo.NoteText(id); note != "" {
						tm["notes"] = note
					}
				}
			}
		}
	}
	b, err := json.Marshal(state)
	return string(b), err
}

// SaveSnapshot fans the full frontend state out to both layers: structured entities to
// the record op-log, settings + notes to ygo.
func (c *Coordinator) SaveSnapshot(state string) error {
	c.mu.Lock()
	rec := c.rec
	c.mu.Unlock()
	if err := rec.ApplyLocalSnapshot(state); err != nil {
		return err
	}
	return c.ygo.SaveAux(state)
}

// ---- query pass-throughs (all hit the ONE record.Store) ----

func (c *Coordinator) QueryList(listID, todayKey string) ([]record.TaskRow, error) {
	return c.Record().QueryList(listID, todayKey)
}
func (c *Coordinator) QueryTasks(q record.Query) ([]record.TaskRow, error) {
	return c.Record().QueryTasks(q)
}
func (c *Coordinator) SearchTasks(text string, q record.Query) ([]record.TaskRow, error) {
	return c.Record().SearchTasks(text, q)
}
func (c *Coordinator) CountTasks(q record.Query) (int, error) { return c.Record().CountTasks(q) }
func (c *Coordinator) GetTask(id string) (map[string]any, error) {
	return c.Record().GetTask(id)
}
func (c *Coordinator) CreateTask(t record.TaskInput) (string, error) {
	return c.Record().CreateTask(t)
}
func (c *Coordinator) SetTaskField(id, field string, value any) error {
	return c.Record().SetTaskField(id, field, value)
}
func (c *Coordinator) ToggleComplete(id string, completed bool) error {
	return c.Record().ToggleComplete(id, completed)
}
func (c *Coordinator) MoveTask(id, beforeID, afterID string) error {
	return c.Record().MoveTask(id, beforeID, afterID)
}
func (c *Coordinator) DeleteTask(id string) error { return c.Record().DeleteTask(id) }

// ---- sync ----

// Sync runs one offline-first cycle: structured data via the record op-log, then
// settings + open notes via ygo. Returns a JSON ydstore.SyncResult with the merged
// snapshot. With no server configured it returns the local-only merged snapshot.
func (c *Coordinator) Sync() (string, error) {
	c.mu.Lock()
	server := c.server
	c.mu.Unlock()

	if server.url == "" || server.token == "" {
		snap, err := c.mergedSnapshot()
		if err != nil {
			return "", err
		}
		b, _ := json.Marshal(ydstore.SyncResult{Adapter: "local", Snapshot: snap})
		return string(b), nil
	}

	base := strings.TrimRight(server.url, "/")
	pulled, err := c.recordServerSync(base, server.token)
	if err != nil {
		return "", err
	}
	if _, err := c.ygo.SyncAux(); err != nil {
		return "", err
	}

	snap, err := c.mergedSnapshot()
	if err != nil {
		return "", err
	}
	b, _ := json.Marshal(ydstore.SyncResult{
		Adapter: "server", Pulled: pulled, Applied: pulled, Snapshot: snap,
	})
	return string(b), nil
}

// mergedSnapshot materializes the current merged state (helper for Sync/Load).
func (c *Coordinator) mergedSnapshot() (string, error) {
	c.mu.Lock()
	rec := c.rec
	c.mu.Unlock()
	settings, err := c.ygo.Settings()
	if err != nil {
		return "", err
	}
	return c.materializeLocked(rec, settings)
}

// SyncNote syncs one task's note scope on demand and returns the merged whole-state
// snapshot (so the UI can refresh the note). Marks the note open for later cycles.
func (c *Coordinator) SyncNote(taskID string) (string, error) {
	if _, err := c.ygo.SyncNote(taskID); err != nil {
		return "", err
	}
	return c.mergedSnapshot()
}

// ---- record op-log sync (mirrors backend.js recordServerSync/recordFullReload) ----

type recordsPullResp struct {
	Ops           []json.RawMessage `json:"ops"`
	Cursor        int               `json:"cursor"`
	CursorExpired bool              `json:"cursorExpired"`
}

// recordServerSync pushes pending record ops, then pulls the tenant's ops since our
// cursor and applies them. A cursorExpired pull escalates to a full reload.
func (c *Coordinator) recordServerSync(base, token string) (int, error) {
	c.mu.Lock()
	rec := c.rec
	c.mu.Unlock()

	pending, err := rec.PendingOps(0)
	if err != nil {
		return 0, err
	}
	if len(pending) > 0 {
		ops := make([]json.RawMessage, len(pending))
		seqs := make([]int64, len(pending))
		for i, so := range pending {
			b, _ := json.Marshal(so.Op)
			ops[i] = b
			seqs[i] = so.Seq
		}
		if err := c.post(base+"/v1/records/push", token, map[string]any{"ops": ops}, nil); err != nil {
			return 0, err
		}
		if err := rec.MarkSynced(seqs); err != nil {
			return 0, err
		}
	}

	cur, err := rec.Cursor()
	if err != nil {
		return 0, err
	}
	cursor := 0
	if cur != "" {
		cursor, _ = strconv.Atoi(cur)
	}
	var body recordsPullResp
	if err := c.post(base+"/v1/records/pull", token, map[string]any{"cursor": cursor}, &body); err != nil {
		return 0, err
	}
	// The server GC'd past our cursor — our incremental view may be missing a delete,
	// so we can't trust these deltas. Wipe + rebuild from the whole current copy.
	if body.CursorExpired {
		return c.recordFullReload(base, token)
	}
	ops, err := decodeOps(body.Ops)
	if err != nil {
		return 0, err
	}
	if len(ops) > 0 {
		if err := rec.ApplyRemote(ops); err != nil {
			return 0, err
		}
	}
	if err := rec.SetCursor(strconv.Itoa(body.Cursor)); err != nil {
		return 0, err
	}
	return len(ops), nil
}

// recordFullReload rebuilds local structured state from the server's whole current
// copy after our cursor expired (docs/tombstone-gc §06). It must NOT resurrect an
// entity deleted while we were gone: keep only pending edits to entities still present
// in the copy (plus our own offline creations); drop edits to vanished entities.
func (c *Coordinator) recordFullReload(base, token string) (int, error) {
	c.mu.Lock()
	rec := c.rec
	c.mu.Unlock()

	var body recordsPullResp
	if err := c.post(base+"/v1/records/pull", token, map[string]any{"cursor": 0}, &body); err != nil {
		return 0, err
	}
	fullOps, err := decodeOps(body.Ops)
	if err != nil {
		return 0, err
	}
	// Entities the server still has (a live presence op in the copy).
	live := map[string]bool{}
	for _, o := range fullOps {
		if o.Type == "presence" && o.Present {
			live[o.Kind+":"+o.ID] = true
		}
	}
	isOwnCreate := func(op record.Op) bool { return op.Type == "presence" && op.Present }
	stillLive := func(op record.Op) bool { return live[op.Kind+":"+op.ID] }

	pending, err := rec.PendingOps(0)
	if err != nil {
		return 0, err
	}
	var keep []record.Op
	var allSeqs []int64
	for _, so := range pending {
		allSeqs = append(allSeqs, so.Seq)
		if isOwnCreate(so.Op) || stillLive(so.Op) {
			keep = append(keep, so.Op)
		}
	}
	if len(keep) > 0 {
		raw := make([]json.RawMessage, len(keep))
		for i, op := range keep {
			b, _ := json.Marshal(op)
			raw[i] = b
		}
		if err := c.post(base+"/v1/records/push", token, map[string]any{"ops": raw}, nil); err != nil {
			return 0, err
		}
	}
	// Mark ALL pending synced: kept ops were just pushed; dropped ones are intentionally
	// abandoned (their entities no longer exist).
	if len(allSeqs) > 0 {
		if err := rec.MarkSynced(allSeqs); err != nil {
			return 0, err
		}
	}

	// Wipe and rebuild. record.Store has no in-place wipe, so recreate the DB file.
	c.mu.Lock()
	if err := c.wipeRecordLocked(); err != nil {
		c.mu.Unlock()
		return 0, err
	}
	rec = c.rec
	c.mu.Unlock()

	if len(fullOps) > 0 {
		if err := rec.ApplyRemote(fullOps); err != nil {
			return 0, err
		}
	}
	// Re-apply our kept edits on top (newer than the copy but not yet in it).
	if len(keep) > 0 {
		if err := rec.ApplyRemote(keep); err != nil {
			return 0, err
		}
	}
	// Keep our cursor at the copy's high-water; our just-pushed keep ops re-arrive as
	// harmless echoes on the next incremental pull.
	if err := rec.SetCursor(strconv.Itoa(body.Cursor)); err != nil {
		return 0, err
	}
	return len(fullOps), nil
}

func decodeOps(raw []json.RawMessage) ([]record.Op, error) {
	ops := make([]record.Op, 0, len(raw))
	for _, ro := range raw {
		var op record.Op
		if err := json.Unmarshal(ro, &op); err != nil {
			return nil, err
		}
		ops = append(ops, op)
	}
	return ops, nil
}

// post sends a JSON body with a bearer token; decodes the response into out if non-nil.
func (c *Coordinator) post(url, token string, body any, out any) error {
	buf, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// Close releases both stores (tests / shutdown).
func (c *Coordinator) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.rec != nil {
		return c.rec.Close()
	}
	return nil
}
