package ysync

import (
	"encoding/json"
	"sync"
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
	Pull(scope string, cursor int) (ops []json.RawMessage, newCursor int, err error)
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

func (b *blobRecordStore) Pull(scope string, cursor int) ([]json.RawMessage, int, error) {
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
	return out, len(rl.ops), nil
}
