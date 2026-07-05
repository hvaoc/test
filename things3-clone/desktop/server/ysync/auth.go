// Package ysync is the multi-tenant Yjs (ygo) sync server. Each tenant owns one
// authoritative CRDT document (a ygo *crdt.Doc); every user in that tenant is a
// client of the same document, so a tenant IS a collaborating team. Tenants are
// fully isolated — a client can only ever touch its own tenant's document.
//
// The server is deliberately DOMAIN-AGNOSTIC: it merges opaque Yjs updates and
// answers state-vector diffs. It shares the exact CRDT (github.com/reearth/ygo)
// used by every client, so merges are identical everywhere and there is nothing
// to keep in sync schema-wise.
//
// Auth here is a Phase-1 STUB (see auth.go). Thorough auth — real identities,
// per-tenant membership, roles/permissions, tokens — lands in the next phase
// behind the same Authenticator seam, with no change to the sync core.
package ysync

import (
	"errors"
	"net/http"
	"strings"
)

// ErrUnauthorized is returned when a token can't be resolved to a principal.
var ErrUnauthorized = errors.New("unauthorized")

// Roles within a tenant. Viewers get read-only sync (pull, no push).
const (
	RoleOwner  = "owner"
	RoleEditor = "editor"
	RoleViewer = "viewer"
)

// Principal is the authenticated caller: their user id, the tenant (team) they
// are acting in, and their role there. The sync scope is the TenantID; the Role
// gates writes.
type Principal struct {
	UserID   string
	TenantID string
	Role     string
}

// CanWrite reports whether this principal may push (owners and editors).
func (p Principal) CanWrite() bool { return p.Role == RoleOwner || p.Role == RoleEditor }

// Authenticator resolves a bearer token to a Principal. The real implementation
// (server/auth) resolves tenant-scoped sync tokens; DevAuth below is a stub.
type Authenticator interface {
	Resolve(token string) (Principal, error)
}

// DevAuth is the Phase-1 STUB authenticator. A token is simply "<tenant>:<user>"
// (e.g. "acme:alice"); a token with no ':' is treated as a tenant with an "anon"
// user. There is NO password/signature check yet — do not ship this to
// production. It exists so multi-tenant, multi-user team sync is fully exercisable
// now, and so Phase 2 only has to swap this one type.
type DevAuth struct{}

func (DevAuth) Resolve(token string) (Principal, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return Principal{}, ErrUnauthorized
	}
	tenant, user, ok := strings.Cut(token, ":")
	if !ok || user == "" {
		user = "anon"
	}
	if tenant == "" {
		return Principal{}, ErrUnauthorized
	}
	return Principal{UserID: user, TenantID: tenant, Role: RoleEditor}, nil
}

// bearer extracts a token from the Authorization header, or the ?token= query
// (WebSockets can't set headers from a browser).
func bearer(r *http.Request) string {
	if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
		return strings.TrimPrefix(a, "Bearer ")
	}
	return r.URL.Query().Get("token")
}
