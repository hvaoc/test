package auth

import (
	"strings"

	"things3-clone-desktop/server/ysync"
)

// Member is one person's membership in a workspace, with their profile.
type Member struct {
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	Role        string `json:"role"`
}

func (s *Store) isOwnerLocked(userID, tenantID string) bool {
	r, ok := s.roleLocked(userID, tenantID)
	return ok && r == ysync.RoleOwner
}

func (s *Store) ownerCountLocked(tenantID string) int {
	n := 0
	for _, m := range s.d.Members {
		if m.TenantID == tenantID && m.Role == ysync.RoleOwner {
			n++
		}
	}
	return n
}

func (s *Store) memberCountLocked(tenantID string) int {
	n := 0
	for _, m := range s.d.Members {
		if m.TenantID == tenantID {
			n++
		}
	}
	return n
}

// ListMembers returns everyone in a workspace (caller must be a member).
func (s *Store) ListMembers(actorID, tenantID string) ([]Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.roleLocked(actorID, tenantID); !ok {
		return nil, ErrForbidden
	}
	var out []Member
	for _, m := range s.d.Members {
		if m.TenantID != tenantID {
			continue
		}
		u := s.d.Users[m.UserID]
		mem := Member{UserID: m.UserID, Role: m.Role}
		if u != nil {
			mem.Username, mem.DisplayName, mem.Email = u.Username, u.DisplayName, u.Email
		}
		out = append(out, mem)
	}
	return out, nil
}

// RenameWorkspace changes a workspace's name (owner only).
func (s *Store) RenameWorkspace(actorID, tenantID, name string) (TenantInfo, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return TenantInfo{}, ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isOwnerLocked(actorID, tenantID) {
		return TenantInfo{}, ErrForbidden
	}
	t := s.d.Tenants[tenantID]
	if t == nil {
		return TenantInfo{}, ErrNotFound
	}
	t.Name = name
	s.saveLocked()
	return TenantInfo{ID: t.ID, Name: t.Name, Role: ysync.RoleOwner}, nil
}

// deleteTenantLocked removes a workspace and everything referencing it.
func (s *Store) deleteTenantLocked(tenantID string) {
	delete(s.d.Tenants, tenantID)
	kept := s.d.Members[:0]
	for _, m := range s.d.Members {
		if m.TenantID != tenantID {
			kept = append(kept, m)
		}
	}
	s.d.Members = kept
	for code, tid := range s.d.Workspaces {
		if tid == tenantID {
			delete(s.d.Workspaces, code)
		}
	}
	for code, inv := range s.d.Invites {
		if inv.TenantID == tenantID {
			delete(s.d.Invites, code)
		}
	}
	for tok, g := range s.d.SyncTokens {
		if g.TenantID == tenantID {
			delete(s.d.SyncTokens, tok)
		}
	}
}

// DeleteWorkspace removes a workspace entirely (owner only). The CRDT document on
// the sync server is left orphaned but unreachable (its sync tokens are gone).
func (s *Store) DeleteWorkspace(actorID, tenantID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isOwnerLocked(actorID, tenantID) {
		return ErrForbidden
	}
	s.deleteTenantLocked(tenantID)
	s.saveLocked()
	return nil
}

// LeaveWorkspace removes the caller from a workspace. The last owner can't leave
// a workspace that still has members (transfer ownership or delete it); if they
// are the only member, leaving deletes it.
func (s *Store) LeaveWorkspace(actorID, tenantID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	role, ok := s.roleLocked(actorID, tenantID)
	if !ok {
		return ErrNotFound
	}
	if role == ysync.RoleOwner && s.ownerCountLocked(tenantID) == 1 {
		if s.memberCountLocked(tenantID) > 1 {
			return ErrLastOwner
		}
		s.deleteTenantLocked(tenantID) // sole member owner -> delete
		s.saveLocked()
		return nil
	}
	s.removeMembershipLocked(actorID, tenantID)
	s.saveLocked()
	return nil
}

func (s *Store) removeMembershipLocked(userID, tenantID string) {
	kept := s.d.Members[:0]
	for _, m := range s.d.Members {
		if !(m.UserID == userID && m.TenantID == tenantID) {
			kept = append(kept, m)
		}
	}
	s.d.Members = kept
	// Revoke that user's sync tokens for this workspace so access ends immediately.
	for tok, g := range s.d.SyncTokens {
		if g.UserID == userID && g.TenantID == tenantID {
			delete(s.d.SyncTokens, tok)
		}
	}
}

// ChangeMemberRole updates a member's role (owner only). Can't demote the last owner.
func (s *Store) ChangeMemberRole(actorID, tenantID, targetID, role string) error {
	if !validRole(role) {
		return ErrBadRole
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isOwnerLocked(actorID, tenantID) {
		return ErrForbidden
	}
	cur, ok := s.roleLocked(targetID, tenantID)
	if !ok {
		return ErrNotFound
	}
	if cur == ysync.RoleOwner && role != ysync.RoleOwner && s.ownerCountLocked(tenantID) == 1 {
		return ErrLastOwner
	}
	for i, m := range s.d.Members {
		if m.UserID == targetID && m.TenantID == tenantID {
			s.d.Members[i].Role = role
			break
		}
	}
	// A role change invalidates existing sync tokens (they embed the old role).
	for tok, g := range s.d.SyncTokens {
		if g.UserID == targetID && g.TenantID == tenantID {
			delete(s.d.SyncTokens, tok)
		}
	}
	s.saveLocked()
	return nil
}

// RemoveMember removes someone from a workspace (owner only). Can't remove the
// last owner.
func (s *Store) RemoveMember(actorID, tenantID, targetID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isOwnerLocked(actorID, tenantID) {
		return ErrForbidden
	}
	cur, ok := s.roleLocked(targetID, tenantID)
	if !ok {
		return ErrNotFound
	}
	if cur == ysync.RoleOwner && s.ownerCountLocked(tenantID) == 1 {
		return ErrLastOwner
	}
	s.removeMembershipLocked(targetID, tenantID)
	s.saveLocked()
	return nil
}
