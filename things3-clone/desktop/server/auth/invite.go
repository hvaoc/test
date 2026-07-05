package auth

import (
	"strings"

	"things3-clone-desktop/server/mail"
	"things3-clone-desktop/server/ysync"
)

const inviteTTL = int64(14 * 24 * 3600) // invitations expire after 14 days

type invite struct {
	Code      string `json:"code"`
	TenantID  string `json:"tenantId"`
	Role      string `json:"role"`
	Email     string `json:"email,omitempty"` // where it was emailed (informational)
	CreatedBy string `json:"createdBy"`
	Created   int64  `json:"created"`
	Expires   int64  `json:"expires"` // unix; 0 = never
	Revoked   bool   `json:"revoked"`
}

// InviteResult describes a created or looked-up invitation. URL is the link to
// share (also what the QR code encodes).
type InviteResult struct {
	Code      string `json:"code"`
	URL       string `json:"url"`
	Role      string `json:"role"`
	Email     string `json:"email,omitempty"`
	Workspace string `json:"workspace"`
	Inviter   string `json:"inviter,omitempty"`
	Expires   int64  `json:"expires,omitempty"`
	Emailed   bool   `json:"emailed,omitempty"`
}

func roleRank(r string) int {
	switch r {
	case ysync.RoleOwner:
		return 3
	case ysync.RoleEditor:
		return 2
	case ysync.RoleViewer:
		return 1
	}
	return 0
}

func (s *Store) inviteURL(code string) string { return s.appURL + "/?invite=" + code }

func (s *Store) inviteResultLocked(inv *invite) InviteResult {
	ws := ""
	if t := s.d.Tenants[inv.TenantID]; t != nil {
		ws = t.Name
	}
	return InviteResult{
		Code: inv.Code, URL: s.inviteURL(inv.Code), Role: inv.Role,
		Email: inv.Email, Workspace: ws, Expires: inv.Expires,
	}
}

func (s *Store) inviteValidLocked(inv *invite) bool {
	return inv != nil && !inv.Revoked && (inv.Expires == 0 || s.now() <= inv.Expires)
}

// CreateInvite makes an invitation link for a workspace and, if an email is
// given, sends it via the configured mailer. The caller must be an owner or
// editor, and can't invite at a role higher than their own.
func (s *Store) CreateInvite(actorID, tenantID, role, email string) (InviteResult, error) {
	if !validRole(role) {
		return InviteResult{}, ErrBadRole
	}
	email = strings.TrimSpace(email)

	s.mu.Lock()
	actorRole, ok := s.roleLocked(actorID, tenantID)
	if !ok || actorRole == ysync.RoleViewer || roleRank(role) > roleRank(actorRole) {
		s.mu.Unlock()
		return InviteResult{}, ErrForbidden
	}
	inv := &invite{
		Code: token(), TenantID: tenantID, Role: role, Email: email,
		CreatedBy: actorID, Created: s.now(), Expires: s.now() + inviteTTL,
	}
	s.d.Invites[inv.Code] = inv
	res := s.inviteResultLocked(inv)
	res.Inviter = s.displayNameLocked(actorID)
	mailer := s.mailer
	s.saveLocked()
	s.mu.Unlock()

	// Send email outside the lock (SMTP is slow). Best-effort — the link + QR work
	// even if mail fails.
	if email != "" && mailer != nil {
		subject, html, text := mail.InviteEmail(res.Inviter, res.Workspace, res.URL)
		if err := mailer.Send(email, subject, html, text); err == nil {
			res.Emailed = true
		}
	}
	return res, nil
}

// InviteInfo previews an invitation (for the join screen, before the user is
// necessarily signed in). No side effects.
func (s *Store) InviteInfo(code string) (InviteResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	inv := s.d.Invites[code]
	if !s.inviteValidLocked(inv) {
		return InviteResult{}, ErrInvite
	}
	r := s.inviteResultLocked(inv)
	r.Inviter = s.displayNameLocked(inv.CreatedBy)
	return r, nil
}

// AcceptInvite adds the user to the invited workspace with the invite's role (or
// returns their existing membership if already in).
func (s *Store) AcceptInvite(userID, code string) (TenantInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	inv := s.d.Invites[code]
	if !s.inviteValidLocked(inv) {
		return TenantInfo{}, ErrInvite
	}
	t := s.d.Tenants[inv.TenantID]
	if t == nil {
		return TenantInfo{}, ErrInvite
	}
	if role, member := s.roleLocked(userID, inv.TenantID); member {
		return TenantInfo{ID: t.ID, Name: t.Name, Role: role}, nil
	}
	s.d.Members = append(s.d.Members, membership{UserID: userID, TenantID: inv.TenantID, Role: inv.Role})
	s.saveLocked()
	return TenantInfo{ID: t.ID, Name: t.Name, Role: inv.Role}, nil
}

// ListInvites returns a workspace's active invitations (owner/editor only).
func (s *Store) ListInvites(actorID, tenantID string) ([]InviteResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.roleLocked(actorID, tenantID)
	if !ok || r == ysync.RoleViewer {
		return nil, ErrForbidden
	}
	out := []InviteResult{}
	for _, inv := range s.d.Invites {
		if inv.TenantID == tenantID && s.inviteValidLocked(inv) {
			out = append(out, s.inviteResultLocked(inv))
		}
	}
	return out, nil
}

// RevokeInvite invalidates an invitation (owner/editor of its workspace).
func (s *Store) RevokeInvite(actorID, code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	inv := s.d.Invites[code]
	if inv == nil {
		return ErrNotFound
	}
	r, ok := s.roleLocked(actorID, inv.TenantID)
	if !ok || r == ysync.RoleViewer {
		return ErrForbidden
	}
	inv.Revoked = true
	s.saveLocked()
	return nil
}
