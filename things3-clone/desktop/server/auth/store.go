// Package auth is the Phase-2 identity layer for the sync server: real users
// (bcrypt passwords), tenants (teams), and per-tenant roles, plus the tokens the
// sync layer authorizes against. It implements ysync.Authenticator, so the sync
// core stays domain-agnostic and unchanged — it just asks "who is this token, and
// what may they do in which tenant?".
//
// Two token kinds:
//   - session token  -> a user identity, used for the auth-management endpoints
//     (list/create tenants, invite members, mint a sync token).
//   - sync token      -> scoped to (user, tenant, role); this is what a client
//     stores and sends to /v1/push and /v1/pull. Because the tenant is baked into
//     the token, the existing {url, token} client plumbing needs no new fields.
//
// Everything persists to one JSON file so accounts and sessions survive restarts.
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	"things3-clone-desktop/server/mail"
	"things3-clone-desktop/server/ysync"

	"golang.org/x/crypto/bcrypt"
)

var (
	ErrExists       = errors.New("username already taken")
	ErrCredentials  = errors.New("invalid username or password")
	ErrNoUsername   = errors.New("username is required")
	ErrWeakPassword = errors.New("password must be at least 6 characters")
	ErrUnauthorized = errors.New("unauthorized")
	ErrForbidden    = errors.New("forbidden")
	ErrNotFound     = errors.New("not found")
	ErrBadRole      = errors.New("invalid role")
	ErrLastOwner    = errors.New("you are the last owner — transfer ownership or delete the workspace")
	ErrInvite       = errors.New("invitation is invalid, revoked, or expired")
)

func validRole(r string) bool {
	return r == ysync.RoleOwner || r == ysync.RoleEditor || r == ysync.RoleViewer
}

type user struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	Email       string `json:"email,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	PassHash    string `json:"passHash"`
	Verified    bool   `json:"verified"`
	Created     int64  `json:"created"`
}

type tenant struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Created int64  `json:"created"`
}

type membership struct {
	UserID   string `json:"userId"`
	TenantID string `json:"tenantId"`
	Role     string `json:"role"`
}

// syncGrant is what a sync token resolves to.
type syncGrant struct {
	UserID   string `json:"userId"`
	TenantID string `json:"tenantId"`
	Role     string `json:"role"`
}

type data struct {
	Users       map[string]*user     `json:"users"`       // id -> user
	UsersByName map[string]string    `json:"usersByName"` // lower(username) -> id
	Tenants     map[string]*tenant   `json:"tenants"`     // id -> tenant
	Members     []membership         `json:"members"`
	Sessions    map[string]string    `json:"sessions"`    // token -> userId
	SyncTokens  map[string]syncGrant `json:"syncTokens"`  // token -> grant
	Workspaces  map[string]string    `json:"workspaces"`  // shared workspace code -> tenantId
	Invites     map[string]*invite   `json:"invites"`     // invite code -> invite
	Verify      map[string]string    `json:"verify"`      // email-verification code -> userId
	Resets      map[string]string    `json:"resets"`      // password-reset code -> userId
}

// Store is the identity database.
type Store struct {
	mu   sync.Mutex
	path string
	now  func() int64
	d    data

	mailer mail.Mailer // sends invitation emails (LogMailer if unset)
	appURL string      // base URL used to build invite/join links
}

// Open loads the store from path (creating an empty one if absent). Pass "" for
// an in-memory store (tests).
func Open(path string) (*Store, error) {
	s := &Store{
		path:   path,
		now:    func() int64 { return time.Now().Unix() },
		mailer: mail.LogMailer{},
		appURL: "http://localhost:8081",
	}
	s.d = data{
		Users: map[string]*user{}, UsersByName: map[string]string{},
		Tenants: map[string]*tenant{}, Sessions: map[string]string{},
		SyncTokens: map[string]syncGrant{}, Workspaces: map[string]string{},
		Invites: map[string]*invite{}, Verify: map[string]string{},
		Resets: map[string]string{},
	}
	if path == "" {
		return s, nil
	}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.d); err != nil {
		return nil, err
	}
	if s.d.Workspaces == nil { // older data files predate shared workspaces
		s.d.Workspaces = map[string]string{}
	}
	if s.d.Invites == nil {
		s.d.Invites = map[string]*invite{}
	}
	if s.d.Verify == nil {
		s.d.Verify = map[string]string{}
	}
	if s.d.Resets == nil {
		s.d.Resets = map[string]string{}
	}
	return s, nil
}

// findUserIDLocked resolves a login identifier (username OR email) to a user id.
func (s *Store) findUserIDLocked(identifier string) (string, bool) {
	key := strings.ToLower(strings.TrimSpace(identifier))
	if uid, ok := s.d.UsersByName[key]; ok {
		return uid, true
	}
	for _, u := range s.d.Users { // fall back to email match
		if u.Email != "" && strings.ToLower(u.Email) == key {
			return u.ID, true
		}
	}
	return "", false
}

// SetMail configures the mailer and the app base URL used in invite links.
func (s *Store) SetMail(m mail.Mailer, appURL string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m != nil {
		s.mailer = m
	}
	if appURL != "" {
		s.appURL = strings.TrimRight(appURL, "/")
	}
}

// JoinWorkspace creates-or-joins a shared workspace by `code`: the first user to
// use a code owns the new workspace; anyone else who enters the same code joins
// it as an editor. This is the simplest way for two accounts to collaborate. Open
// join (anyone with the code) is fine for now; proper invites already exist via
// AddMember for tighter control.
func (s *Store) JoinWorkspace(userID, code string) (TenantInfo, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return TenantInfo{}, ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	tid, ok := s.d.Workspaces[code]
	if !ok {
		t := &tenant{ID: id("tenant"), Name: code, Created: s.now()}
		s.d.Tenants[t.ID] = t
		s.d.Workspaces[code] = t.ID
		s.d.Members = append(s.d.Members, membership{UserID: userID, TenantID: t.ID, Role: ysync.RoleOwner})
		s.saveLocked()
		return TenantInfo{ID: t.ID, Name: t.Name, Role: ysync.RoleOwner}, nil
	}
	if role, member := s.roleLocked(userID, tid); member {
		return TenantInfo{ID: tid, Name: s.d.Tenants[tid].Name, Role: role}, nil
	}
	s.d.Members = append(s.d.Members, membership{UserID: userID, TenantID: tid, Role: ysync.RoleEditor})
	s.saveLocked()
	return TenantInfo{ID: tid, Name: s.d.Tenants[tid].Name, Role: ysync.RoleEditor}, nil
}

func (s *Store) saveLocked() {
	if s.path == "" {
		return
	}
	b, err := json.MarshalIndent(s.d, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

func token() string {
	var b [24]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
func id(prefix string) string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}

// --- account lifecycle ------------------------------------------------------

// Register creates a user + a personal tenant they own, and returns a session
// token and the user id. Email is optional.
func (s *Store) Register(username, email, password string) (sessionToken, userID string, err error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return "", "", ErrNoUsername
	}
	if len(password) < 6 {
		return "", "", ErrWeakPassword
	}
	s.mu.Lock()
	key := strings.ToLower(username)
	if _, ok := s.d.UsersByName[key]; ok {
		s.mu.Unlock()
		return "", "", ErrExists
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		s.mu.Unlock()
		return "", "", err
	}
	u := &user{
		ID: id("user"), Username: username, Email: strings.TrimSpace(email),
		PassHash: string(hash), Created: s.now(),
	}
	s.d.Users[u.ID] = u
	s.d.UsersByName[key] = u.ID

	// A personal tenant so a solo user works immediately; teams add more.
	t := &tenant{ID: id("tenant"), Name: username, Created: s.now()}
	s.d.Tenants[t.ID] = t
	s.d.Members = append(s.d.Members, membership{UserID: u.ID, TenantID: t.ID, Role: ysync.RoleOwner})

	tok := token()
	s.d.Sessions[tok] = u.ID

	// Email verification: if an email was given, issue a code + link to send.
	name, vEmail, vURL, mailer := u.Username, u.Email, "", s.mailer
	if u.Email != "" {
		code := token()
		s.d.Verify[code] = u.ID
		vURL = s.appURL + "/?verify=" + code
	}
	s.saveLocked()
	s.mu.Unlock()

	if vEmail != "" && vURL != "" && mailer != nil {
		subject, html, text := mail.VerifyEmail(name, vURL)
		_ = mailer.Send(vEmail, subject, html, text)
	}
	return tok, u.ID, nil
}

// Login verifies credentials (identifier may be a username OR an email) and
// returns a session token.
func (s *Store) Login(identifier, password string) (sessionToken, userID string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	uid, ok := s.findUserIDLocked(identifier)
	if !ok {
		return "", "", ErrCredentials
	}
	u := s.d.Users[uid]
	if bcrypt.CompareHashAndPassword([]byte(u.PassHash), []byte(password)) != nil {
		return "", "", ErrCredentials
	}
	tok := token()
	s.d.Sessions[tok] = u.ID
	s.saveLocked()
	return tok, u.ID, nil
}

// SessionUser resolves a session token to a user id (for the auth-management
// endpoints).
func (s *Store) SessionUser(sessionToken string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	uid, ok := s.d.Sessions[sessionToken]
	return uid, ok
}

// --- tenants & membership ---------------------------------------------------

// TenantInfo is a tenant plus the caller's role in it.
type TenantInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

func (s *Store) roleLocked(userID, tenantID string) (string, bool) {
	for _, m := range s.d.Members {
		if m.UserID == userID && m.TenantID == tenantID {
			return m.Role, true
		}
	}
	return "", false
}

// ListTenants returns every tenant the user belongs to, with their role.
func (s *Store) ListTenants(userID string) []TenantInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []TenantInfo
	for _, m := range s.d.Members {
		if m.UserID == userID {
			if t := s.d.Tenants[m.TenantID]; t != nil {
				out = append(out, TenantInfo{ID: t.ID, Name: t.Name, Role: m.Role})
			}
		}
	}
	return out
}

// CreateTenant makes a new team owned by the user.
func (s *Store) CreateTenant(userID, name string) (TenantInfo, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return TenantInfo{}, ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t := &tenant{ID: id("tenant"), Name: name, Created: s.now()}
	s.d.Tenants[t.ID] = t
	s.d.Members = append(s.d.Members, membership{UserID: userID, TenantID: t.ID, Role: ysync.RoleOwner})
	s.saveLocked()
	return TenantInfo{ID: t.ID, Name: t.Name, Role: ysync.RoleOwner}, nil
}

// AddMember adds another user to a tenant with a role. The actor must own the
// tenant. This is how a team forms.
func (s *Store) AddMember(actorID, tenantID, username, role string) error {
	if !validRole(role) {
		return ErrBadRole
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.roleLocked(actorID, tenantID); !ok || r != ysync.RoleOwner {
		return ErrForbidden
	}
	targetID, ok := s.d.UsersByName[strings.ToLower(strings.TrimSpace(username))]
	if !ok {
		return ErrNotFound
	}
	for i, m := range s.d.Members {
		if m.UserID == targetID && m.TenantID == tenantID {
			s.d.Members[i].Role = role // update existing
			s.saveLocked()
			return nil
		}
	}
	s.d.Members = append(s.d.Members, membership{UserID: targetID, TenantID: tenantID, Role: role})
	s.saveLocked()
	return nil
}

// MintSyncToken issues a token scoped to (user, tenant, role) for the sync
// endpoints. The user must be a member of the tenant.
func (s *Store) MintSyncToken(userID, tenantID string) (syncToken, role string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.roleLocked(userID, tenantID)
	if !ok {
		return "", "", ErrForbidden
	}
	tok := token()
	s.d.SyncTokens[tok] = syncGrant{UserID: userID, TenantID: tenantID, Role: r}
	s.saveLocked()
	return tok, r, nil
}

// --- ysync.Authenticator ----------------------------------------------------

// Resolve implements ysync.Authenticator: a sync token -> principal. This is what
// the sync core calls on every push/pull.
func (s *Store) Resolve(syncToken string) (ysync.Principal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.d.SyncTokens[syncToken]
	if !ok {
		return ysync.Principal{}, ErrUnauthorized
	}
	return ysync.Principal{UserID: g.UserID, TenantID: g.TenantID, Role: g.Role}, nil
}
