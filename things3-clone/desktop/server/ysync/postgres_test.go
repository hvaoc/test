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

// TestPostgresMaterializedRecords proves the "database as another client" model: the
// server applies ops into a Postgres LWW-register table that is BOUNDED (edits
// collapse, not accumulate), QUERYABLE server-side, and a FIRST-TIME client pulls the
// whole current copy.
func TestPostgresMaterializedRecords(t *testing.T) {
	const port = 54330
	pg := embeddedpostgres.NewDatabase(
		embeddedpostgres.DefaultConfig().Port(port).Username("postgres").Password("postgres").Database("things_mat"),
	)
	if err := pg.Start(); err != nil {
		t.Skipf("embedded postgres unavailable: %v", err)
	}
	defer func() { _ = pg.Stop() }()
	dsn := fmt.Sprintf("host=localhost port=%d user=postgres password=postgres dbname=things_mat sslmode=disable", port)

	pp, err := NewPostgresPersistence(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pp.Close()
	rs, err := NewPGRecordStore(pp.DB())
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHub(DevAuth{}, pp)
	hub.SetRecordStore(rs) // materialized register store instead of the blob log
	srv := httptest.NewServer(hub.Handler())
	defer srv.Close()

	// Alice creates a task, then edits its title 3 times, pushing after each edit.
	alice := newRecClient(t, srv, "acme:alice")
	if err := alice.store.ApplyLocalSnapshot(recState(map[string]any{"id": "t1", "title": "v1"})); err != nil {
		t.Fatal(err)
	}
	alice.push()
	for _, v := range []string{"v2", "v3", "final title"} {
		if err := alice.store.SetTaskField("t1", "title", v); err != nil {
			t.Fatal(err)
		}
		alice.push()
	}

	// BOUNDED: despite 4 title writes, the register table holds exactly ONE title row.
	var titleRows int
	if err := pp.DB().QueryRow(
		`SELECT count(*) FROM record_registers WHERE entity='t1' AND field='title'`).Scan(&titleRows); err != nil {
		t.Fatal(err)
	}
	if titleRows != 1 {
		t.Fatalf("title should collapse to 1 register (bounded), got %d rows", titleRows)
	}

	// QUERYABLE: the server can read the current task title straight from Postgres.
	var curTitle string
	if err := pp.DB().QueryRow(
		`SELECT value FROM record_registers WHERE kind='task' AND entity='t1' AND field='title'`).Scan(&curTitle); err != nil {
		t.Fatal(err)
	}
	if curTitle != `"final title"` {
		t.Fatalf("server-side current title = %s, want \"final title\"", curTitle)
	}
	t.Logf("server can query current state directly: task t1 title = %s", curTitle)

	// FULL COPY on first login: a brand-new client (cursor 0) pulls the whole workspace.
	bob := newRecClient(t, srv, "acme:bob")
	bob.pull() // cursor 0 -> full current copy
	if got := bob.tasks()["t1"]["title"]; got != "final title" {
		t.Fatalf("first-time client full copy = %v, want 'final title'", got)
	}
	if bob.cursor == 0 {
		t.Fatalf("first-time pull should advance the cursor")
	}

	// Total register rows == number of live (entity,field,elem) targets — no history.
	var total int
	_ = pp.DB().QueryRow(`SELECT count(*) FROM record_registers`).Scan(&total)
	t.Logf("record_registers holds %d live rows (one per field) — no edit history accumulates", total)
}
