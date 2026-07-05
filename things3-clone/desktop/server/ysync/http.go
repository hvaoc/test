package ysync

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"github.com/gorilla/websocket"
)

// Handler builds the HTTP router for the sync API.
//
//	GET  /v1/health              -> {status}
//	POST /v1/push   (auth)       {update:b64}     -> {version}
//	POST /v1/pull   (auth)       {sv:b64}         -> {update:b64, version}
//	GET  /v1/stream (auth ?token) websocket, nudges {type:"changed", version}
//
// Updates and state vectors are opaque Yjs bytes, base64-encoded in JSON.
func (h *Hub) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/v1/push", h.authed(h.handlePush))
	mux.HandleFunc("/v1/pull", h.authed(h.handlePull))
	mux.HandleFunc("/v1/stream", h.handleStream)
	return cors(mux)
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

func (h *Hub) handlePush(scope string, _ Principal, w http.ResponseWriter, r *http.Request) {
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

// handleStream upgrades to a WebSocket and pushes a nudge whenever the tenant's
// document changes, so connected teammates pull promptly (realtime). The token
// arrives via ?token= because browsers can't set WS headers.
func (h *Hub) handleStream(w http.ResponseWriter, r *http.Request) {
	p, err := h.auth.Resolve(bearer(r))
	if err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	scope := h.Scope(p, r)
	room, err := h.room(scope)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	id, ch := room.subscribe()
	defer room.unsubscribe(id)

	// Reader goroutine: detect client close.
	closed := make(chan struct{})
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				close(closed)
				return
			}
		}
	}()

	for {
		select {
		case ver, ok := <-ch:
			if !ok {
				return
			}
			if err := conn.WriteJSON(map[string]any{"type": "changed", "version": ver}); err != nil {
				return
			}
		case <-closed:
			return
		}
	}
}

// --- helpers ---

func cors(next http.Handler) http.Handler {
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
