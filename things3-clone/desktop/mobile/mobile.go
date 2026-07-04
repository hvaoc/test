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

	"things3-clone-desktop/core"
)

var (
	mu    sync.Mutex
	store *core.Store
)

// Open initialises the database under dir (the app's writable files directory,
// supplied by the native side) and attaches the mock cloud adapter. Call once
// at app launch. Safe to call again (re-opens).
func Open(dir string) error {
	mu.Lock()
	defer mu.Unlock()
	s, err := core.Open(dir)
	if err != nil {
		return err
	}
	s.SetAdapter(core.NewMockAdapter(dir))
	store = s
	return nil
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

// Sync runs one push/pull cycle and returns a JSON SyncResult.
func Sync() (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if store == nil {
		return "", errNotOpen
	}
	return store.Sync()
}

var errNotOpen = errors.New("playdata: store not open (call Open first)")
