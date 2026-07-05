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
	mux.HandleFunc("/v1/join", s.session(s.handleJoin))
	mux.HandleFunc("/v1/synctoken", s.session(s.handleSyncToken))

	// Profile + email verification
	mux.HandleFunc("/v1/profile", s.session(s.handleProfile))
	mux.HandleFunc("/v1/password", s.session(s.handleChangePassword))
	mux.HandleFunc("/v1/verify", s.handleVerify)                              // public
	mux.HandleFunc("/v1/resend-verification", s.session(s.handleResendVerify))

	// Workspace lifecycle + members
	mux.HandleFunc("/v1/workspaces/rename", s.session(s.handleRenameWorkspace))
	mux.HandleFunc("/v1/workspaces/delete", s.session(s.handleDeleteWorkspace))
	mux.HandleFunc("/v1/workspaces/leave", s.session(s.handleLeaveWorkspace))
	mux.HandleFunc("/v1/workspaces/members", s.session(s.handleListMembers))
	mux.HandleFunc("/v1/workspaces/members/role", s.session(s.handleChangeRole))
	mux.HandleFunc("/v1/workspaces/members/remove", s.session(s.handleRemoveMember))

	// Invitations
	mux.HandleFunc("/v1/invites", s.session(s.handleInvites))          // GET list, POST create
	mux.HandleFunc("/v1/invites/revoke", s.session(s.handleRevokeInvite))
	mux.HandleFunc("/v1/invites/accept", s.session(s.handleAcceptInvite))
	mux.HandleFunc("/v1/invites/info", s.handleInviteInfo)             // public preview
}

// errStatus maps a store error to an HTTP status.
func errStatus(err error) int {
	switch err {
	case ErrForbidden, ErrLastOwner:
		return 403
	case ErrNotFound:
		return 404
	case ErrExists:
		return 409
	case ErrCredentials, ErrUnauthorized:
		return 401
	default:
		return 400
	}
}

func (s *Store) handleJoin(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	t, err := s.JoinWorkspace(userID, req.Code)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"tenant": t})
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
	Email    string `json:"email"`
	Password string `json:"password"`
}
type authResp struct {
	Token   string       `json:"token"` // session token
	UserID  string       `json:"userId"`
	Profile Profile      `json:"profile"`
	Tenants []TenantInfo `json:"tenants"`
}

func (s *Store) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req credsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	tok, uid, err := s.Register(req.Username, req.Email, req.Password)
	if err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, authResp{Token: tok, UserID: uid, Profile: s.GetProfile(uid), Tenants: s.ListTenants(uid)})
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
	writeJSON(w, 200, authResp{Token: tok, UserID: uid, Profile: s.GetProfile(uid), Tenants: s.ListTenants(uid)})
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

// --- profile ---

func (s *Store) handleProfile(userID string, w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var req struct {
			DisplayName string `json:"displayName"`
			Email       string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, 400, "bad request")
			return
		}
		p, err := s.UpdateProfile(userID, req.DisplayName, req.Email)
		if err != nil {
			writeErr(w, errStatus(err), err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"profile": p})
		return
	}
	writeJSON(w, 200, map[string]any{"profile": s.GetProfile(userID), "tenants": s.ListTenants(userID)})
}

func (s *Store) handleChangePassword(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := s.ChangePassword(userID, req.Old, req.New); err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleVerify is public: it consumes an email-verification code.
func (s *Store) handleVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	if r.Method == http.MethodPost {
		_ = json.NewDecoder(r.Body).Decode(&req)
	} else {
		req.Code = r.URL.Query().Get("code")
	}
	if _, err := s.Verify(req.Code); err != nil {
		writeErr(w, 400, "this verification link is invalid or already used")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true, "verified": true})
}

func (s *Store) handleResendVerify(userID string, w http.ResponseWriter, r *http.Request) {
	if err := s.ResendVerification(userID); err != nil {
		writeErr(w, 400, "add an email to your profile first")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// --- workspace lifecycle + members ---

func (s *Store) handleRenameWorkspace(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		TenantID string `json:"tenantId"`
		Name     string `json:"name"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		writeErr(w, 400, "bad request")
		return
	}
	t, err := s.RenameWorkspace(userID, req.TenantID, req.Name)
	if err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"tenant": t})
}

func (s *Store) handleDeleteWorkspace(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		TenantID string `json:"tenantId"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := s.DeleteWorkspace(userID, req.TenantID); err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Store) handleLeaveWorkspace(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		TenantID string `json:"tenantId"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := s.LeaveWorkspace(userID, req.TenantID); err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Store) handleListMembers(userID string, w http.ResponseWriter, r *http.Request) {
	members, err := s.ListMembers(userID, r.URL.Query().Get("tenantId"))
	if err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"members": members})
}

func (s *Store) handleChangeRole(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		TenantID string `json:"tenantId"`
		UserID   string `json:"userId"`
		Role     string `json:"role"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := s.ChangeMemberRole(userID, req.TenantID, req.UserID, req.Role); err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Store) handleRemoveMember(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		TenantID string `json:"tenantId"`
		UserID   string `json:"userId"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := s.RemoveMember(userID, req.TenantID, req.UserID); err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// --- invitations ---

func (s *Store) handleInvites(userID string, w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var req struct {
			TenantID string `json:"tenantId"`
			Role     string `json:"role"`
			Email    string `json:"email"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		inv, err := s.CreateInvite(userID, req.TenantID, req.Role, req.Email)
		if err != nil {
			writeErr(w, errStatus(err), err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"invite": inv})
		return
	}
	invites, err := s.ListInvites(userID, r.URL.Query().Get("tenantId"))
	if err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"invites": invites})
}

func (s *Store) handleRevokeInvite(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := s.RevokeInvite(userID, req.Code); err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Store) handleAcceptInvite(userID string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		writeErr(w, 400, "bad request")
		return
	}
	t, err := s.AcceptInvite(userID, req.Code)
	if err != nil {
		writeErr(w, errStatus(err), err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"tenant": t})
}

// handleInviteInfo is public (no session) so a join screen can preview an
// invitation before the user signs in.
func (s *Store) handleInviteInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		return
	}
	inv, err := s.InviteInfo(r.URL.Query().Get("code"))
	if err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"invite": inv})
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
