package ysync

import (
	"database/sql"

	_ "github.com/lib/pq" // Postgres driver for database/sql
)

// PostgresPersistence stores each scope's blob — a tenant's ygo snapshot, a per-task
// note doc, a user's settings doc, or a tenant's record OP-LOG — as one row in a
// single key/value table. It satisfies the Persistence interface, so the whole sync
// server (ygo rooms + the record op-log in records.go) durably persists to Postgres
// with no change to any sync logic. This is the server storage tier from
// docs/architecture-1m.md §5.4.
//
// Blob form keeps the interface identical to the file/mem stores. The scaling
// follow-up for the record log is an append-only `ops` table (one row per op) instead
// of rewriting the whole log blob per push — a change local to this layer.
type PostgresPersistence struct {
	db *sql.DB
}

// NewPostgresPersistence opens the DSN (e.g.
// "postgres://user:pass@host:5432/db?sslmode=disable") and ensures the table exists.
func NewPostgresPersistence(dsn string) (*PostgresPersistence, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS sync_blobs (
		scope      TEXT PRIMARY KEY,
		data       BYTEA NOT NULL,
		updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`); err != nil {
		db.Close()
		return nil, err
	}
	return &PostgresPersistence{db: db}, nil
}

// Load returns a scope's stored blob, or nil if none exists yet.
func (p *PostgresPersistence) Load(scope string) ([]byte, error) {
	var data []byte
	err := p.db.QueryRow(`SELECT data FROM sync_blobs WHERE scope = $1`, scope).Scan(&data)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return data, nil
}

// Save upserts a scope's blob. Concurrency-safe via the DB (ON CONFLICT upsert);
// Postgres serializes the row write, so no app-level lock is needed.
func (p *PostgresPersistence) Save(scope string, snapshot []byte) error {
	_, err := p.db.Exec(`INSERT INTO sync_blobs (scope, data, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (scope) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
		scope, snapshot)
	return err
}

// Close releases the connection pool.
func (p *PostgresPersistence) Close() error { return p.db.Close() }
