package ysync

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"github.com/gorilla/websocket"
)

// Mount registers the sync routes on mux (so it can share a mux with the auth
// routes). Updates and state vectors are opaque Yjs bytes, base64 in JSON.
//
//	GET  /v1/health              -> {status}
//	POST /v1/push   (auth)       {update:b64}     -> {version}   (owner/editor only)
//	POST /v1/pull   (auth)       {sv:b64}         -> {update:b64, sv, version}
//	GET  /v1/stream (auth ?token) websocket, nudges {type:"changed", version}
func (h *Hub) Mount(mux *http.ServeMux) {
	mux.HandleFunc("/v1/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/v1/push", h.authed(h.handlePush))
	mux.HandleFunc("/v1/pull", h.authed(h.handlePull))
	mux.HandleFunc("/v1/stream", h.handleStream)
}

// Handler builds a standalone HTTP router for the sync API (tests / sync-only
// deployments). Production mounts auth + sync on one mux; see cmd/ysync-server.
func (h *Hub) Handler() http.Handler {
	mux := http.NewServeMux()
	h.Mount(mux)
	return CORS(mux)
}

// authed resolves the bearer token to a principal + scope and invokes fn. The
// scope is the tenant document the caller may touch — enforced here, so a handler
// can never reach another tenant's data.
func (h *Hub) authed(fn func(scope string, p Principal, w http.ResponseWriter, r *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := h.auth.Resolve(bearer(r))
		if err != nil {
			writeErr(w, 401, "unauthorized")
			return
		}
		fn(h.Scope(p, r), p, w, r)
	}
}

type pushReq struct {
	Update string `json:"update"` // base64 Yjs update
}
type pushResp struct {
	Version int64 `json:"version"`
}

func (h *Hub) handlePush(scope string, p Principal, w http.ResponseWriter, r *http.Request) {
	if !p.CanWrite() {
		writeErr(w, 403, "read-only: your role in this tenant cannot make changes")
		return
	}
	var req pushReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	update, err := b64dec(req.Update)
	if err != nil {
		writeErr(w, 400, "bad update encoding")
		return
	}
	ver, err := h.Push(scope, update)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, pushResp{Version: ver})
}

type pullReq struct {
	SV string `json:"sv"` // base64 client state vector ("" = full state)
}
type pullResp struct {
	Update  string `json:"update"` // base64 diff the client is missing
	SV      string `json:"sv"`     // base64 server state vector (for the client's push)
	Version int64  `json:"version"`
}

func (h *Hub) handlePull(scope string, _ Principal, w http.ResponseWriter, r *http.Request) {
	var req pullReq
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req) // empty body allowed -> full state
	}
	sv, err := b64dec(req.SV)
	if err != nil {
		writeErr(w, 400, "bad sv encoding")
		return
	}
	update, serverSV, ver, err := h.Pull(scope, sv)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, pullResp{Update: b64enc(update), SV: b64enc(serverSV), Version: ver})
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // browser origin differs from API; Phase 1
}

// handleStream upgrades to a WebSocket for realtime: it nudges connected
// teammates when the document changes (so they pull) AND relays awareness
// (presence + cursors) between them. The token arrives via ?token= because
// browsers can't set WS headers.
//
// Client -> server frames: {"type":"presence","state":{...}} — broadcast to peers.
// Server -> client frames:
//   {"type":"changed","version":n}           data changed; pull
//   {"type":"presence","from":id,"state":{}}  a peer's awareness state
//   {"type":"presence-leave","from":id}       a peer disconnected
// `from` is an opaque per-connection id; the client identity lives inside `state`.
func (h *Hub) handleStream(w http.ResponseWriter, r *http.Request) {
	p, err := h.auth.Resolve(bearer(r))
	if err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	room, err := h.room(h.Scope(p, r))
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	c, existing := room.join()
	defer room.leave(c.id)

	// Send whoever is already present to the newcomer.
	for _, frame := range existing {
		_ = ws.WriteMessage(websocket.TextMessage, frame)
	}

	// Reader goroutine: relay this client's awareness to peers; detect close. Only
	// editors/owners may broadcast presence into a room (viewers still receive).
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var in struct {
				Type  string          `json:"type"`
				State json.RawMessage `json:"state"`
			}
			if json.Unmarshal(msg, &in) == nil && in.Type == "presence" && p.CanWrite() {
				room.setPresence(c.id, in.State)
			}
		}
	}()

	// Writer: drain this connection's queue to the socket.
	for {
		select {
		case frame, ok := <-c.out:
			if !ok {
				return
			}
			if err := ws.WriteMessage(websocket.TextMessage, frame); err != nil {
				return
			}
		case <-closed:
			return
		}
	}
}

// --- helpers ---

// CORS wraps a handler with permissive CORS so the browser (a different origin
// than the API) can call it. Phase-1/2 permissive; lock the origin down for prod.
func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func b64enc(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
func b64dec(s string) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(s)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
