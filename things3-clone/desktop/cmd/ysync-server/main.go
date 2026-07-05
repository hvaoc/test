// Command ysync-server runs the multi-tenant Yjs (ygo) sync server.
//
//	go run ./cmd/ysync-server -addr :8090 -data ./ysync-data
//
// Phase 1: auth is the DevAuth stub — a bearer token is "<tenant>:<user>"
// (e.g. "acme:alice"). All users sharing a tenant collaborate on one document;
// tenants are isolated. Thorough auth arrives in the next phase behind the same
// Authenticator seam.
package main

import (
	"flag"
	"log"
	"net/http"

	"things3-clone-desktop/server/ysync"
)

func main() {
	addr := flag.String("addr", ":8090", "listen address")
	data := flag.String("data", "", "directory for per-tenant persistence (empty = in-memory)")
	flag.Parse()

	var store ysync.Persistence
	if *data == "" {
		store = ysync.NewMemPersistence()
		log.Printf("ysync: in-memory persistence (data lost on restart)")
	} else {
		fp, err := ysync.NewFilePersistence(*data)
		if err != nil {
			log.Fatalf("ysync: persistence: %v", err)
		}
		store = fp
		log.Printf("ysync: file persistence at %s", *data)
	}

	hub := ysync.NewHub(ysync.DevAuth{}, store)
	log.Printf("ysync: listening on %s (auth: DevAuth STUB — token is \"tenant:user\")", *addr)
	if err := http.ListenAndServe(*addr, hub.Handler()); err != nil {
		log.Fatal(err)
	}
}
