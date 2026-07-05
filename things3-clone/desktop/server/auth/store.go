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

	"things3-clone-desktop/server/ysync"

	"golang.org/x/crypto/bcrypt"
)

var (
	ErrExists       = errors.New("username already taken")
	ErrCredentials  = errors.New("invalid username or password")
	ErrUnauthorized = errors.New("unauthorized")
	ErrForbidden    = errors.New("forbidden")
	ErrNotFound     = errors.New("not found")
	ErrBadRole      = errors.New("invalid role")
)

func validRole(r string) bool {
	return r == ysync.RoleOwner || r == ysync.RoleEditor || r == ysync.RoleViewer
}

type user struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	PassHash string `json:"passHash"`
	Created  int64  `json:"created"`
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
	Users       map[string]*user       `json:"users"`       // id -> user
	UsersByName map[string]string      `json:"usersByName"` // lower(username) -> id
	Tenants     map[string]*tenant     `json:"tenants"`     // id -> tenant
	Members     []membership           `json:"members"`
	Sessions    map[string]string      `json:"sessions"`    // token -> userId
	SyncTokens  map[string]syncGrant   `json:"syncTokens"`  // token -> grant
}

// Store is the identity database.
type Store struct {
	mu   sync.Mutex
	path string
	now  func() int64
	d    data
}

// Open loads the store from path (creating an empty one if absent). Pass "" for
// an in-memory store (tests).
func Open(path string) (*Store, error) {
	s := &Store{path: path, now: func() int64 { return time.Now().Unix() }}
	s.d = data{
		Users: map[string]*user{}, UsersByName: map[string]string{},
		Tenants: map[string]*tenant{}, Sessions: map[string]string{},
		SyncTokens: map[string]syncGrant{},
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
	return s, nil
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
// token and the user id.
func (s *Store) Register(username, password string) (sessionToken, userID string, err error) {
	username = strings.TrimSpace(username)
	if username == "" || len(password) < 6 {
		return "", "", ErrCredentials
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := strings.ToLower(username)
	if _, ok := s.d.UsersByName[key]; ok {
		return "", "", ErrExists
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", "", err
	}
	u := &user{ID: id("user"), Username: username, PassHash: string(hash), Created: s.now()}
	s.d.Users[u.ID] = u
	s.d.UsersByName[key] = u.ID

	// A personal tenant so a solo user works immediately; teams add more.
	t := &tenant{ID: id("tenant"), Name: username, Created: s.now()}
	s.d.Tenants[t.ID] = t
	s.d.Members = append(s.d.Members, membership{UserID: u.ID, TenantID: t.ID, Role: ysync.RoleOwner})

	tok := token()
	s.d.Sessions[tok] = u.ID
	s.saveLocked()
	return tok, u.ID, nil
}

// Login verifies credentials and returns a session token.
func (s *Store) Login(username, password string) (sessionToken, userID string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	uid, ok := s.d.UsersByName[strings.ToLower(strings.TrimSpace(username))]
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
