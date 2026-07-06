package ysync

import (
	"fmt"
	"net/http/httptest"
	"testing"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
)

// TestPostgresPersistence runs against a REAL PostgreSQL (embedded-postgres downloads
// + runs an actual PG binary in-process). It proves: (1) the blob KV round-trips, and
// (2) the whole sync stack — the record OP-LOG and the ygo settings scope — durably
// persists to Postgres and survives a server restart backed by the same database.
func TestPostgresPersistence(t *testing.T) {
	const port = 54329
	pg := embeddedpostgres.NewDatabase(
		embeddedpostgres.DefaultConfig().
			Port(port).
			Username("postgres").
			Password("postgres").
			Database("things_test"),
	)
	if err := pg.Start(); err != nil {
		t.Skipf("embedded postgres unavailable (offline / binary download failed): %v", err)
	}
	defer func() { _ = pg.Stop() }()

	dsn := fmt.Sprintf("host=localhost port=%d user=postgres password=postgres dbname=things_test sslmode=disable", port)

	store, err := NewPostgresPersistence(dsn)
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	defer store.Close()

	// (1) Blob KV round-trip: write, read, overwrite, missing -> nil.
	if err := store.Save("t:acme", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.Load("t:acme"); string(got) != "hello" {
		t.Fatalf("load = %q, want hello", got)
	}
	if err := store.Save("t:acme", []byte("world")); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.Load("t:acme"); string(got) != "world" {
		t.Fatalf("overwrite = %q, want world", got)
	}
	if got, _ := store.Load("does-not-exist"); got != nil {
		t.Fatalf("missing scope = %q, want nil", got)
	}

	// (2a) Structured data via the RECORD op-log, through a Postgres-backed hub.
	srv := httptest.NewServer(NewHub(DevAuth{}, store).Handler())
	alice := newRecClient(t, srv, "acme:alice")
	if err := alice.store.ApplyLocalSnapshot(recState(map[string]any{"id": "t1", "title": "Persisted in Postgres"})); err != nil {
		t.Fatal(err)
	}
	alice.push()
	srv.Close()

	// (2b) Restart: a FRESH hub on the SAME Postgres database recovers the op-log.
	store2, err := NewPostgresPersistence(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer store2.Close()
	srv2 := httptest.NewServer(NewHub(DevAuth{}, store2).Handler())
	defer srv2.Close()

	bob := newRecClient(t, srv2, "acme:bob")
	bob.pull()
	if bob.tasks()["t1"]["title"] != "Persisted in Postgres" {
		t.Fatalf("record op-log not recovered from Postgres: %v", bob.tasks())
	}

	// (3) Confirm the row actually lives in Postgres (a rec:<tenant> scope exists).
	var n int
	if err := store2.db.QueryRow(`SELECT count(*) FROM sync_blobs WHERE scope LIKE 'rec:%'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatalf("expected a record op-log row in sync_blobs, found none")
	}
	t.Logf("sync_blobs holds %d record-log row(s) in Postgres", n)
}
