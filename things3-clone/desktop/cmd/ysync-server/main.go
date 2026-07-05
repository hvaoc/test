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

	"things3-clone-desktop/server/auth"
	"things3-clone-desktop/server/mail"
	"things3-clone-desktop/server/ysync"
)

func main() {
	addr := flag.String("addr", ":8090", "listen address")
	data := flag.String("data", "", "directory for persistence (empty = in-memory, lost on restart)")
	smtp := flag.String("smtp", "localhost:1025", "SMTP host:port for invite emails (dev: MailPit); empty = log only")
	mailFrom := flag.String("mail-from", "PlayTasks <no-reply@playtasks.local>", "From address for emails")
	appURL := flag.String("app-url", "http://localhost:8081", "base URL of the web app, used in invite links")
	flag.Parse()

	var store ysync.Persistence
	authPath := ""
	if *data == "" {
		store = ysync.NewMemPersistence()
		log.Printf("ysync: in-memory persistence (accounts + data lost on restart)")
	} else {
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
	ysync.NewHub(accounts, store).Mount(mux)

	log.Printf("ysync: listening on %s (real accounts: /v1/register, /v1/login)", *addr)
	if err := http.ListenAndServe(*addr, ysync.CORS(mux)); err != nil {
		log.Fatal(err)
	}
}
