package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"things3-clone-desktop/core"

	"github.com/gorilla/websocket"
)

// Handler builds the HTTP router for the sync API.
func (h *Hub) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/register", h.handleRegister)
	mux.HandleFunc("/v1/login", h.handleLogin)
	mux.HandleFunc("/v1/push", h.authed(h.handlePush))
	mux.HandleFunc("/v1/pull", h.authed(h.handlePull))
	mux.HandleFunc("/v1/stream", h.handleStream) // authed via ?token=
	mux.HandleFunc("/v1/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	return cors(mux)
}

// cors adds permissive CORS so the browser (a different origin than the API) can
// call it, and answers preflight requests. Prototype-permissive; lock the
// origin down for production.
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

type credsReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}
type authResp struct {
	Token  string `json:"token"`
	UserID string `json:"userId"`
}

func (h *Hub) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req credsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	tok, uid, err := h.Register(req.Username, req.Password)
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, authResp{Token: tok, UserID: uid})
}

func (h *Hub) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req credsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	tok, uid, err := h.Login(req.Username, req.Password)
	if err != nil {
		writeErr(w, 401, err.Error())
		return
	}
	writeJSON(w, 200, authResp{Token: tok, UserID: uid})
}

// authed wraps a handler, resolving the bearer token to a user id passed via the
// request context header "X-User".
func (h *Hub) authed(fn func(userID string, w http.ResponseWriter, r *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := bearer(r)
		uid, err := h.Auth(tok)
		if err != nil {
			writeErr(w, 401, "unauthorized")
			return
		}
		fn(uid, w, r)
	}
}

func bearer(r *http.Request) string {
	a := r.Header.Get("Authorization")
	if strings.HasPrefix(a, "Bearer ") {
		return strings.TrimPrefix(a, "Bearer ")
	}
	return ""
}

type pushReq struct {
	Ops []core.Op `json:"ops"`
}

func (h *Hub) handlePush(userID string, w http.ResponseWriter, r *http.Request) {
	var req pushReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := h.Push(userID, req.Ops); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]interface{}{"ok": true, "count": len(req.Ops)})
}

type pullResp struct {
	Ops    []core.Op `json:"ops"`
	Cursor string    `json:"cursor"`
}

func (h *Hub) handlePull(userID string, w http.ResponseWriter, r *http.Request) {
	cursor := 0
	if c := r.URL.Query().Get("cursor"); c != "" {
		cursor, _ = strconv.Atoi(c)
	}
	ops, next := h.Pull(userID, cursor)
	if ops == nil {
		ops = []core.Op{}
	}
	writeJSON(w, 200, pullResp{Ops: ops, Cursor: strconv.Itoa(next)})
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // prototype: any origin
}

// handleStream upgrades to a WebSocket and pushes a small nudge whenever the
// user's log grows, so connected devices pull promptly (realtime). The browser
// can't set an Authorization header on a WebSocket, so the token comes via
// ?token=.
func (h *Hub) handleStream(w http.ResponseWriter, r *http.Request) {
	uid, err := h.Auth(r.URL.Query().Get("token"))
	if err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	signal, unsub := h.Subscribe(uid)
	defer unsub()

	// Reader goroutine: detect close.
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
		case n := <-signal:
			if err := conn.WriteJSON(map[string]interface{}{"type": "changed", "count": n}); err != nil {
				return
			}
		case <-closed:
			return
		}
	}
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
