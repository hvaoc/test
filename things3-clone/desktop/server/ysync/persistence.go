package ysync

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
)

// Persistence durably stores one merged Yjs snapshot per tenant so a server
// restart recovers every tenant's document. It stores opaque bytes — no schema.
//
// Phase 1 keeps the whole merged state per tenant (compact binary). A later phase
// can switch to an append-only update log + periodic compaction (MergeUpdatesV1 +
// RunGC) for O(edit) writes; the interface is unchanged.
type Persistence interface {
	// Load returns the tenant's stored snapshot, or nil if none exists yet.
	Load(tenant string) ([]byte, error)
	// Save replaces the tenant's snapshot.
	Save(tenant string, snapshot []byte) error
}

// MemPersistence is an in-memory store (tests, ephemeral deployments).
type MemPersistence struct {
	mu sync.Mutex
	m  map[string][]byte
}

func NewMemPersistence() *MemPersistence { return &MemPersistence{m: map[string][]byte{}} }

func (p *MemPersistence) Load(tenant string) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if b, ok := p.m[tenant]; ok {
		return append([]byte(nil), b...), nil
	}
	return nil, nil
}

func (p *MemPersistence) Save(tenant string, snapshot []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.m[tenant] = append([]byte(nil), snapshot...)
	return nil
}

// FilePersistence stores one file per tenant under dir. Tenant ids are hex-encoded
// into filenames so any id is filesystem-safe with no collisions.
type FilePersistence struct {
	dir string
	mu  sync.Mutex
}

func NewFilePersistence(dir string) (*FilePersistence, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &FilePersistence{dir: dir}, nil
}

func (p *FilePersistence) path(tenant string) string {
	return filepath.Join(p.dir, hex.EncodeToString([]byte(tenant))+".yupd")
}

func (p *FilePersistence) Load(tenant string) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	b, err := os.ReadFile(p.path(tenant))
	if os.IsNotExist(err) {
		return nil, nil
	}
	return b, err
}

// Save writes atomically (temp file + rename) so a crash mid-write can't corrupt
// a tenant's document.
func (p *FilePersistence) Save(tenant string, snapshot []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	final := p.path(tenant)
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, snapshot, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}
