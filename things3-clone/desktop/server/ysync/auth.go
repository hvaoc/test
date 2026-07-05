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

// Principal is the authenticated caller: which tenant (team) they belong to and
// who they are within it. UserID is carried through for realtime attribution and
// future per-user authorization; the sync scope is the TenantID.
type Principal struct {
	TenantID string
	UserID   string
}

// Authenticator resolves a bearer token to a Principal. Phase 2 replaces the stub
// with real identity + membership + roles without touching the sync core.
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
	return Principal{TenantID: tenant, UserID: user}, nil
}

// bearer extracts a token from the Authorization header, or the ?token= query
// (WebSockets can't set headers from a browser).
func bearer(r *http.Request) string {
	if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
		return strings.TrimPrefix(a, "Bearer ")
	}
	return r.URL.Query().Get("token")
}
