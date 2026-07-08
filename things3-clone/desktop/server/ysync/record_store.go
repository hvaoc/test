package ysync

import (
	"encoding/json"
	"sync"
	"time"
)

// RecordStore is the storage + transport for the structured-data op stream
// (tasks/projects/areas as field-level CRDT ops). Push takes a client's ops and
// returns a cursor; Pull returns what's after a cursor (cursor 0 = a full copy).
//
// Two implementations:
//   - blobRecordStore — an append-only op LOG (full history in one growing blob).
//     The dumb-relay default: simple, but grows unbounded and isn't queryable.
//   - pgRecordStore — a MATERIALIZED LWW-register store in Postgres (one row per
//     entity/field). Bounded (superseded edits overwrite in place), queryable
//     server-side, and a first-time client pulls a full copy of the current state.
//     This is "the database as another client" (docs/architecture-1m.md §5.4).
type RecordStore interface {
	Push(scope string, ops []json.RawMessage) (cursor int, err error)
	// Pull returns ops after cursor (0 = a full copy). expired=true means the client's
	// cursor has fallen below the GC watermark (a purged delete may be missing from its
	// incremental view) and it must wipe + full-reload; only the materialized Postgres
	// store ever sets it (docs/tombstone-gc.html §03).
	Pull(scope string, cursor int) (ops []json.RawMessage, newCursor int, expired bool, err error)
}

// RecordGC is implemented by stores that garbage-collect tombstones on a timer. Only the
// materialized Postgres store qualifies; the append-only blob log keeps full history and
// never purges, so it never expires a cursor. The server wires a ticker when present.
type RecordGC interface {
	RunGC(retention time.Duration) (reclaimed int, err error)
}

// ---- blob impl: an append-only log persisted via the Persistence blob layer ----

type recordLog struct {
	mu  sync.Mutex
	ops []json.RawMessage
}

type blobRecordStore struct {
	store Persistence
	mu    sync.Mutex
	logs  map[string]*recordLog
}

func newBlobRecordStore(store Persistence) *blobRecordStore {
	return &blobRecordStore{store: store, logs: map[string]*recordLog{}}
}

func recStoreKey(scope string) string { return "rec:" + scope }

func (b *blobRecordStore) logFor(scope string) *recordLog {
	b.mu.Lock()
	defer b.mu.Unlock()
	if rl, ok := b.logs[scope]; ok {
		return rl
	}
	rl := &recordLog{}
	if blob, err := b.store.Load(recStoreKey(scope)); err == nil && len(blob) > 0 {
		_ = json.Unmarshal(blob, &rl.ops)
	}
	b.logs[scope] = rl
	return rl
}

func (b *blobRecordStore) Push(scope string, ops []json.RawMessage) (int, error) {
	rl := b.logFor(scope)
	rl.mu.Lock()
	rl.ops = append(rl.ops, ops...)
	n := len(rl.ops)
	blob, _ := json.Marshal(rl.ops)
	rl.mu.Unlock()
	if err := b.store.Save(recStoreKey(scope), blob); err != nil {
		return n, err
	}
	return n, nil
}

// Pull never expires a cursor: the blob log keeps full history and never purges, so any
// cursor can still be served incrementally (expired is always false).
func (b *blobRecordStore) Pull(scope string, cursor int) ([]json.RawMessage, int, bool, error) {
	rl := b.logFor(scope)
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if cursor < 0 {
		cursor = 0
	}
	if cursor > len(rl.ops) {
		cursor = len(rl.ops)
	}
	out := make([]json.RawMessage, len(rl.ops)-cursor)
	copy(out, rl.ops[cursor:])
	return out, len(rl.ops), false, nil
}
