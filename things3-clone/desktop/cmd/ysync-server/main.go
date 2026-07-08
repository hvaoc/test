// Command ysync-server runs the multi-tenant Yjs (ygo) sync server with real
// accounts.
//
//	go run ./cmd/ysync-server -addr :8090 -data ./ysync-data
//
// Phase 2: register/login create real users (bcrypt) and tenants (teams) with
// per-tenant roles (owner/editor/viewer). Clients log in, pick a tenant, mint a
// tenant-scoped SYNC token, and use that token for /v1/push and /v1/pull. Viewers
// are read-only. See server/auth and docs/crdt-ygo.md.
package main

import (
	"flag"
	"log"
	"net/http"
	"path/filepath"
	"time"

	"things3-clone-desktop/server/auth"
	"things3-clone-desktop/server/mail"
	"things3-clone-desktop/server/ysync"
)

// tombstoneRetention is how long a delete's tombstone is kept before the GC forgets it.
// It MUST exceed any client's staleness threshold (30d) so a client that synced within
// its window still finds every delete it missed still retained (docs/tombstone-gc.html §04).
const tombstoneRetention = 35 * 24 * time.Hour

func main() {
	addr := flag.String("addr", ":8090", "listen address")
	data := flag.String("data", "", "directory for persistence (empty = in-memory, lost on restart)")
	pgDSN := flag.String("postgres", "", "Postgres DSN for sync persistence (e.g. postgres://user:pass@host:5432/db?sslmode=disable); when set, sync data lives in Postgres and -data (if given) holds only the accounts file")
	smtp := flag.String("smtp", "localhost:1025", "SMTP host:port for invite emails (dev: MailPit); empty = log only")
	mailFrom := flag.String("mail-from", "PlayTasks <no-reply@playtasks.local>", "From address for emails")
	appURL := flag.String("app-url", "http://localhost:8081", "base URL of the web app, used in invite links")
	flag.Parse()

	var store ysync.Persistence
	var pgStore *ysync.PostgresPersistence
	authPath := ""
	switch {
	case *pgDSN != "":
		pg, err := ysync.NewPostgresPersistence(*pgDSN)
		if err != nil {
			log.Fatalf("ysync: postgres: %v", err)
		}
		store = pg
		pgStore = pg
		if *data != "" {
			authPath = filepath.Join(*data, "auth.json")
		}
		log.Printf("ysync: Postgres persistence for sync data; accounts at %q", authPath)
	case *data == "":
		store = ysync.NewMemPersistence()
		log.Printf("ysync: in-memory persistence (accounts + data lost on restart)")
	default:
		fp, err := ysync.NewFilePersistence(*data)
		if err != nil {
			log.Fatalf("ysync: persistence: %v", err)
		}
		store = fp
		authPath = filepath.Join(*data, "auth.json")
		log.Printf("ysync: file persistence at %s", *data)
	}

	accounts, err := auth.Open(authPath)
	if err != nil {
		log.Fatalf("ysync: auth store: %v", err)
	}

	// Invite email: MailPit in dev (view at http://localhost:8025), or log-only.
	var mailer mail.Mailer = mail.LogMailer{}
	if *smtp != "" {
		mailer = &mail.SMTPMailer{Addr: *smtp, From: *mailFrom}
		log.Printf("ysync: invite email via SMTP %s (from %q); app links use %s", *smtp, *mailFrom, *appURL)
	} else {
		log.Printf("ysync: invite email disabled (log only); app links use %s", *appURL)
	}
	accounts.SetMail(mailer, *appURL)

	// One mux: auth routes + sync routes. The sync layer authorizes every push/pull
	// against the accounts store (a tenant-scoped sync token -> user+tenant+role).
	mux := http.NewServeMux()
	accounts.Mount(mux)
	hub := ysync.NewHub(accounts, store)
	if pgStore != nil {
		// Materialized record engine: the server keeps a bounded, queryable LWW-register
		// copy of all structured data, and a first-time client pulls the full copy.
		rs, err := ysync.NewPGRecordStore(pgStore.DB())
		if err != nil {
			log.Fatalf("ysync: postgres record store: %v", err)
		}
		hub.SetRecordStore(rs)
		log.Printf("ysync: materialized record engine on Postgres (bounded, queryable full copy)")
		// Tombstone GC: purge deletes older than the retention window + sweep orphaned
		// field rows, hourly, raising each tenant's cursor-expiry watermark (docs/tombstone-gc).
		if gc, ok := rs.(ysync.RecordGC); ok {
			go runTombstoneGC(gc)
			log.Printf("ysync: tombstone GC active (%s retention, hourly purge + watermark)", tombstoneRetention)
		}
		// One-time: fold any legacy append-only record blobs into the register store.
		var regCount int
		_ = pgStore.DB().QueryRow(`SELECT count(*) FROM record_registers`).Scan(&regCount)
		if regCount == 0 {
			if migrated, err := ysync.MigrateBlobLog(pgStore, rs); err != nil {
				log.Printf("ysync: blob->register migration: %v", err)
			} else if migrated > 0 {
				log.Printf("ysync: migrated %d legacy record blob(s) into the register store", migrated)
			}
		}
	}
	hub.Mount(mux)

	log.Printf("ysync: listening on %s (real accounts: /v1/register, /v1/login)", *addr)
	if err := http.ListenAndServe(*addr, ysync.CORS(mux)); err != nil {
		log.Fatal(err)
	}
}

// runTombstoneGC purges expired tombstones once at startup, then hourly. Errors are
// logged and retried on the next tick (a transient DB hiccup shouldn't kill the loop).
func runTombstoneGC(gc ysync.RecordGC) {
	sweep := func() {
		if n, err := gc.RunGC(tombstoneRetention); err != nil {
			log.Printf("ysync: tombstone GC: %v", err)
		} else if n > 0 {
			log.Printf("ysync: tombstone GC reclaimed %d row(s)", n)
		}
	}
	sweep()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for range t.C {
		sweep()
	}
}
