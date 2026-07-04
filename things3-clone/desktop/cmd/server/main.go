// Command server runs the multi-user sync backend for the Things clone.
//
//	go run ./cmd/server -addr :8090 -data ./sync-data.json
//
// Clients (Go desktop/mobile via core.HTTPAdapter, JS web via backend.js) push
// and pull CRDT ops through it and receive realtime nudges over a WebSocket.
package main

import (
	"flag"
	"log"
	"net/http"

	"things3-clone-desktop/server"
)

func main() {
	addr := flag.String("addr", ":8090", "listen address")
	data := flag.String("data", "", "path to persistence file (empty = in-memory)")
	flag.Parse()

	hub := server.NewHub(*data)
	log.Printf("sync server listening on %s (data=%q)", *addr, *data)
	if err := http.ListenAndServe(*addr, hub.Handler()); err != nil {
		log.Fatal(err)
	}
}
