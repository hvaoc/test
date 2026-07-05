package auth

import (
	"encoding/json"
	"net/http"
	"strings"

	"things3-clone-desktop/server/ysync"
)

// Mount registers the auth routes on mux (shares the mux with the sync routes):
//
//	POST /v1/register {username,password}          -> {token, userId, tenants}
//	POST /v1/login    {username,password}          -> {token, userId, tenants}
//	GET  /v1/tenants               (session)       -> {tenants}
//	POST /v1/tenants  {name}       (session)       -> {tenant}
//	POST /v1/members  {tenantId,username,role}     -> {ok}   (owner only)
//	POST /v1/synctoken {tenantId}  (session)       -> {token, role}
//
// `token` from register/login is a SESSION token (identity). `token` from
// /v1/synctoken is a tenant-scoped SYNC token — that's what the client stores and
// sends to /v1/push and /v1/pull.
func (s *Store) Mount(mux *http.ServeMux) {
	mux.HandleFunc("/v1/register", s.handleRegister)
	mux.HandleFunc("/v1/login", s.handleLogin)
	mux.HandleFunc("/v1/tenants", s.session(s.handleTenants))
	mux.HandleFunc("/v1/members", s.session(s.handleAddMember))
	mux.HandleFunc("/v1/synctoken", s.session(s.handleSyncToken))
}

// Handler builds a standalone router (tests). Production mounts auth + sync on
// one mux; see cmd/ysync-server.
func (s *Store) Handler() http.Handler {
	mux := http.NewServeMux()
	s.Mount(mux)
	return ysync.CORS(mux)
}

type credsReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}
type authResp struct {
	Token   string       `json:"token"`  // session token
	UserID  string       `json:"userId"`
	Tenants []TenantInfo `json:"tenants"`
}

func (s *Store) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req credsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	tok, uid, err := s.Register(req.Username, req.Password)
	if err != nil {
		code := 400
		if err == ErrExists {
			code = 409
		}
		writeErr(w, code, err.Error())
		return
	}
	writeJSON(w, 200, authResp{Token: tok, UserID: uid, Tenants: s.ListTenants(uid)})
}

func (s *Store) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req credsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	tok, uid, err := s.Login(req.Username, req.Password)
	if err != nil {
		writeErr(w, 401, err.Error())
		return
	}
	writeJSON(w, 200, authResp{Token: tok, UserID: uid, Tenants: s.ListTenants(uid)})
}

// session wraps a handler, resolving the bearer session token to a user id.
func (s *Store) session(fn func(userID string, w http.ResponseWriter, r *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, ok := s.SessionUser(bearer(r))
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		fn(uid, w, r)
	}
}

func (s *Store) handleTenants(userID string, w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var req struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		t, err := s.CreateTenant(userID, req.Name)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"tenant": t})
		return
	}
	writeJSON(w, 200, map[string]any{"tenants": s.ListTenants(userID)})
}

func (s *Store) handleAddMember(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		TenantID string `json:"tenantId"`
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := s.AddMember(userID, req.TenantID, req.Username, req.Role); err != nil {
		code := 400
		switch err {
		case ErrForbidden:
			code = 403
		case ErrNotFound:
			code = 404
		}
		writeErr(w, code, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Store) handleSyncToken(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		TenantID string `json:"tenantId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	tok, role, err := s.MintSyncToken(userID, req.TenantID)
	if err != nil {
		writeErr(w, 403, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"token": tok, "role": role})
}

// --- small helpers ---

func bearer(r *http.Request) string {
	a := r.Header.Get("Authorization")
	if strings.HasPrefix(a, "Bearer ") {
		return strings.TrimPrefix(a, "Bearer ")
	}
	return r.URL.Query().Get("token")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
