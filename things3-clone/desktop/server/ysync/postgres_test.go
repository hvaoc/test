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

// TestPostgresTombstoneGC proves the delete/lagger design (docs/tombstone-gc.html):
// deletes are purged after their retention window (so the DB never leaks tombstones),
// the purge raises a per-tenant watermark, a client whose cursor fell below it is told
// to full-reload (cursorExpired), and a full reload neither resurrects the delete nor
// loop-expires (the full-copy cursor is floored at the watermark).
func TestPostgresTombstoneGC(t *testing.T) {
	const port = 54331
	pg := embeddedpostgres.NewDatabase(
		embeddedpostgres.DefaultConfig().Port(port).Username("postgres").Password("postgres").Database("things_gc"),
	)
	if err := pg.Start(); err != nil {
		t.Skipf("embedded postgres unavailable: %v", err)
	}
	defer func() { _ = pg.Stop() }()
	dsn := fmt.Sprintf("host=localhost port=%d user=postgres password=postgres dbname=things_gc sslmode=disable", port)

	pp, err := NewPostgresPersistence(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pp.Close()
	rs, err := NewPGRecordStore(pp.DB())
	if err != nil {
		t.Fatal(err)
	}
	gc, ok := rs.(RecordGC)
	if !ok {
		t.Fatal("pg record store should implement RecordGC")
	}
	hub := NewHub(DevAuth{}, pp)
	hub.SetRecordStore(rs)
	srv := httptest.NewServer(hub.Handler())
	defer srv.Close()

	// Alice creates t1 + t2 and pushes; Bob syncs and remembers his cursor.
	alice := newRecClient(t, srv, "acme:alice")
	if err := alice.store.ApplyLocalSnapshot(recState(
		map[string]any{"id": "t1", "title": "delete me"},
		map[string]any{"id": "t2", "title": "keep me"},
	)); err != nil {
		t.Fatal(err)
	}
	alice.push()

	bob := newRecClient(t, srv, "acme:bob")
	bob.pull()
	if _, ok := bob.tasks()["t1"]; !ok {
		t.Fatalf("bob should see t1 before the delete: %v", bob.tasks())
	}
	staleCursor := bob.cursor
	if staleCursor == 0 {
		t.Fatal("bob's cursor should have advanced")
	}

	// Alice deletes t1 — a snapshot without it emits presence(t1)=false — and pushes.
	if err := alice.store.ApplyLocalSnapshot(recState(
		map[string]any{"id": "t2", "title": "keep me"},
	)); err != nil {
		t.Fatal(err)
	}
	alice.push()

	// GC with zero retention purges the tombstone at once and raises the watermark. Run
	// twice: pass 1 purges the presence row, pass 2 sweeps t1's now-orphaned title row
	// (the two DELETEs share a snapshot, so the field is reclaimed one pass later).
	if _, err := gc.RunGC(0); err != nil {
		t.Fatal(err)
	}
	if _, err := gc.RunGC(0); err != nil {
		t.Fatal(err)
	}

	// Requirement 1: nothing about t1 remains — no leaked tombstone, no orphaned field.
	var t1rows int
	_ = pp.DB().QueryRow(`SELECT count(*) FROM record_registers WHERE entity='t1'`).Scan(&t1rows)
	if t1rows != 0 {
		t.Fatalf("t1 should be fully reclaimed after GC, found %d row(s)", t1rows)
	}
	var watermark int
	if err := pp.DB().QueryRow(`SELECT watermark FROM record_gc WHERE scope='acme'`).Scan(&watermark); err != nil {
		t.Fatalf("a watermark row should exist after GC: %v", err)
	}
	if staleCursor >= watermark {
		t.Fatalf("bob's stale cursor (%d) must be below the watermark (%d) to trigger expiry", staleCursor, watermark)
	}

	// Requirement 2: bob's incremental pull at his stale cursor is EXPIRED — he can't be
	// trusted to have the delete, so the server refuses to ship deltas.
	resp := bob.post("/v1/records/pull", map[string]any{"cursor": staleCursor})
	if exp, _ := resp["cursorExpired"].(bool); !exp {
		t.Fatalf("stale-cursor pull should be cursorExpired, got %v", resp)
	}

	// Full reload (cursor 0) rebuilds the whole current copy: t2 present, t1 gone — the
	// delete is NOT resurrected even though its tombstone was purged.
	carol := newRecClient(t, srv, "acme:carol")
	carol.pull()
	if _, ok := carol.tasks()["t1"]; ok {
		t.Fatalf("full reload must not resurrect the deleted t1: %v", carol.tasks())
	}
	if carol.tasks()["t2"]["title"] != "keep me" {
		t.Fatalf("full reload lost the surviving t2: %v", carol.tasks())
	}

	// D8 guardrail: the full-copy cursor is floored at the watermark, so the freshly
	// reloaded client does not immediately loop-expire on its next pull.
	if carol.cursor < watermark {
		t.Fatalf("full-copy cursor (%d) must be floored at the watermark (%d)", carol.cursor, watermark)
	}
	resp2 := carol.post("/v1/records/pull", map[string]any{"cursor": carol.cursor})
	if exp, _ := resp2["cursorExpired"].(bool); exp {
		t.Fatalf("a caught-up client must not expire, got %v", resp2)
	}
	t.Logf("tombstone GC: watermark=%d; stale cursor %d expired; full reload dropped t1, kept t2", watermark, staleCursor)
}
