// Package mobile is the gomobile entry point: it wraps the shared core engine
// (embedded SQLite + cloud sync) in a flat, bind-friendly API so the SAME Go
// code that backs the Wails desktop app also backs the iOS and Android apps.
//
// Build the bindings with:
//
//	# iOS (produces Playdata.xcframework)
//	gomobile bind -target=ios -o ../ios/Playdata.xcframework ./
//	# Android (produces playdata.aar)
//	gomobile bind -target=android -androidapi 24 -o ../android/playdata.aar ./
//
// gomobile only supports a narrow set of types across the language boundary
// (string, []byte, int, bool, error, and bound structs), so every method here
// speaks JSON strings — exactly what the React Native native module bridges to
// JS (see ../reactnative).
package mobile

import (
	"errors"
	"sync"

	"things3-clone-desktop/core/ydstore"
)

var (
	mu    sync.Mutex
	store *ydstore.Store
)

// Open initialises the ygo replica under dir (the app's writable files directory,
// supplied by the native side). Call once at app launch. Safe to call again
// (re-opens). Attach a sync server later via SetServer once the user signs in.
func Open(dir string) error {
	mu.Lock()
	defer mu.Unlock()
	s, err := ydstore.Open(dir)
	if err != nil {
		return err
	}
	store = s
	return nil
}

// SetServer / ClearServer connect this device to a sync server (same account as
// web/desktop). The native side calls these after the JS layer authenticates.
func SetServer(url, token string) {
	mu.Lock()
	defer mu.Unlock()
	if store != nil {
		store.SetServer(url, token)
	}
}

func ClearServer() {
	mu.Lock()
	defer mu.Unlock()
	if store != nil {
		store.ClearServer()
	}
}

// Reset wipes all local data (backs "Delete all data").
func Reset() error {
	mu.Lock()
	defer mu.Unlock()
	if store == nil {
		return errNotOpen
	}
	return store.Reset()
}

// LoadSnapshot returns the persisted state JSON, or "" when the DB is empty (so
// the JS layer falls back to seed data).
func LoadSnapshot() (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if store == nil {
		return "", errNotOpen
	}
	has, err := store.HasData()
	if err != nil || !has {
		return "", err
	}
	return store.LoadSnapshot()
}

// SaveSnapshot persists the full frontend state (the JS layer debounces calls).
func SaveSnapshot(state string) error {
	mu.Lock()
	defer mu.Unlock()
	if store == nil {
		return errNotOpen
	}
	return store.SaveSnapshot(state)
}

// Sync runs one push/pull cycle (shared + settings + open notes) and returns a
// JSON SyncResult.
func Sync() (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if store == nil {
		return "", errNotOpen
	}
	return store.Sync()
}

// SyncNote syncs one task's note scope on demand (call when its detail view opens)
// and returns the merged whole-state snapshot so the UI can refresh the note.
func SyncNote(taskID string) (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if store == nil {
		return "", errNotOpen
	}
	return store.SyncNote(taskID)
}

// CloseNote stops syncing a task's note scope (call when its detail view closes).
func CloseNote(taskID string) error {
	mu.Lock()
	defer mu.Unlock()
	if store == nil {
		return errNotOpen
	}
	store.CloseNote(taskID)
	return nil
}

var errNotOpen = errors.New("playdata: store not open (call Open first)")
