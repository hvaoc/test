package auth

import (
	"testing"

	"things3-clone-desktop/server/ysync"
)

// recMailer records what would be sent.
type recMailer struct {
	to   []string
	subj []string
}

func (m *recMailer) Send(to, subject, _, _ string) error {
	m.to = append(m.to, to)
	m.subj = append(m.subj, subject)
	return nil
}

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open("")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mustReg(t *testing.T, s *Store, name string) string {
	t.Helper()
	_, uid, err := s.Register(name, name+"@x.com", "pass123")
	if err != nil {
		t.Fatalf("register %s: %v", name, err)
	}
	return uid
}

func TestInviteFlow_EmailAndAccept(t *testing.T) {
	s := newStore(t)
	rec := &recMailer{}
	s.SetMail(rec, "http://app.test")

	alice := mustReg(t, s, "alice")
	ws, _ := s.CreateTenant(alice, "Acme")

	inv, err := s.CreateInvite(alice, ws.ID, ysync.RoleEditor, "bob@x.com")
	if err != nil {
		t.Fatal(err)
	}
	if inv.Code == "" || inv.URL == "" {
		t.Fatalf("invite missing code/url: %+v", inv)
	}
	if inv.URL != "http://app.test/?invite="+inv.Code {
		t.Fatalf("bad invite url: %s", inv.URL)
	}
	// (Registering with an email also sends a verification email, so just check
	// the invite reached bob.)
	if !inv.Emailed || rec.to[len(rec.to)-1] != "bob@x.com" {
		t.Fatalf("invite email not sent correctly: emailed=%v to=%v", inv.Emailed, rec.to)
	}

	// Preview works before joining.
	info, err := s.InviteInfo(inv.Code)
	if err != nil || info.Workspace != "Acme" || info.Role != ysync.RoleEditor {
		t.Fatalf("invite info: %+v %v", info, err)
	}

	// Bob accepts and becomes an editor.
	bob := mustReg(t, s, "bob")
	tin, err := s.AcceptInvite(bob, inv.Code)
	if err != nil || tin.ID != ws.ID || tin.Role != ysync.RoleEditor {
		t.Fatalf("accept: %+v %v", tin, err)
	}
	members, _ := s.ListMembers(alice, ws.ID)
	if len(members) != 2 {
		t.Fatalf("want 2 members, got %d", len(members))
	}

	// Revoked invites can't be accepted.
	if err := s.RevokeInvite(alice, inv.Code); err != nil {
		t.Fatal(err)
	}
	carol := mustReg(t, s, "carol")
	if _, err := s.AcceptInvite(carol, inv.Code); err != ErrInvite {
		t.Fatalf("revoked accept should fail with ErrInvite, got %v", err)
	}
}

func TestInvitePermissions(t *testing.T) {
	s := newStore(t)
	alice := mustReg(t, s, "alice")
	ws, _ := s.CreateTenant(alice, "Acme")

	// A viewer can't invite.
	bob := mustReg(t, s, "bob")
	iv, _ := s.CreateInvite(alice, ws.ID, ysync.RoleViewer, "")
	s.AcceptInvite(bob, iv.Code)
	if _, err := s.CreateInvite(bob, ws.ID, ysync.RoleViewer, ""); err != ErrForbidden {
		t.Fatalf("viewer invite should be forbidden: %v", err)
	}

	// An editor can't invite someone at owner level.
	carol := mustReg(t, s, "carol")
	ie, _ := s.CreateInvite(alice, ws.ID, ysync.RoleEditor, "")
	s.AcceptInvite(carol, ie.Code)
	if _, err := s.CreateInvite(carol, ws.ID, ysync.RoleOwner, ""); err != ErrForbidden {
		t.Fatalf("editor inviting owner should be forbidden: %v", err)
	}
}

func TestWorkspaceLifecycle(t *testing.T) {
	s := newStore(t)
	alice := mustReg(t, s, "alice")
	ws, _ := s.CreateTenant(alice, "Acme")

	if r, err := s.RenameWorkspace(alice, ws.ID, "Acme Corp"); err != nil || r.Name != "Acme Corp" {
		t.Fatalf("rename: %+v %v", r, err)
	}

	bob := mustReg(t, s, "bob")
	iv, _ := s.CreateInvite(alice, ws.ID, ysync.RoleEditor, "")
	s.AcceptInvite(bob, iv.Code)

	if _, err := s.RenameWorkspace(bob, ws.ID, "Nope"); err != ErrForbidden {
		t.Fatalf("non-owner rename should be forbidden: %v", err)
	}

	// Promote bob, then alice (no longer the only owner) can leave.
	if err := s.ChangeMemberRole(alice, ws.ID, bob, ysync.RoleOwner); err != nil {
		t.Fatal(err)
	}
	if err := s.LeaveWorkspace(alice, ws.ID); err != nil {
		t.Fatalf("owner leave with another owner present: %v", err)
	}
	// Bob deletes the workspace.
	if err := s.DeleteWorkspace(bob, ws.ID); err != nil {
		t.Fatal(err)
	}
	for _, tn := range s.ListTenants(bob) {
		if tn.ID == ws.ID {
			t.Fatal("workspace should be gone after delete")
		}
	}
}

func TestLastOwnerProtection(t *testing.T) {
	s := newStore(t)
	alice := mustReg(t, s, "alice")
	ws, _ := s.CreateTenant(alice, "Acme")
	bob := mustReg(t, s, "bob")
	iv, _ := s.CreateInvite(alice, ws.ID, ysync.RoleEditor, "")
	s.AcceptInvite(bob, iv.Code)

	if err := s.LeaveWorkspace(alice, ws.ID); err != ErrLastOwner {
		t.Fatalf("last owner leaving a populated workspace should fail: %v", err)
	}
	if err := s.ChangeMemberRole(alice, ws.ID, alice, ysync.RoleEditor); err != ErrLastOwner {
		t.Fatalf("demoting the last owner should fail: %v", err)
	}
	if err := s.RemoveMember(alice, ws.ID, alice); err != ErrLastOwner {
		t.Fatalf("removing the last owner should fail: %v", err)
	}
}

func TestEmailVerification(t *testing.T) {
	s := newStore(t)
	rec := &recMailer{}
	s.SetMail(rec, "http://app.test")

	_, uid, err := s.Register("dave", "dave@x.com", "pass123")
	if err != nil {
		t.Fatal(err)
	}
	if s.GetProfile(uid).Verified {
		t.Fatal("account should start unverified")
	}
	if len(rec.to) != 1 || rec.to[0] != "dave@x.com" {
		t.Fatalf("verification email not sent: %v", rec.to)
	}

	var code string
	s.mu.Lock()
	for c, id := range s.d.Verify {
		if id == uid {
			code = c
		}
	}
	s.mu.Unlock()
	if code == "" {
		t.Fatal("no verification code issued")
	}

	if _, err := s.Verify(code); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !s.GetProfile(uid).Verified {
		t.Fatal("account should be verified after using the code")
	}
	if _, err := s.Verify(code); err == nil {
		t.Fatal("a used verification code should not work again")
	}
}

func TestProfileAndPassword(t *testing.T) {
	s := newStore(t)
	alice := mustReg(t, s, "alice")

	p, err := s.UpdateProfile(alice, "Alice A", "alice@new.com")
	if err != nil || p.DisplayName != "Alice A" || p.Email != "alice@new.com" {
		t.Fatalf("update profile: %+v %v", p, err)
	}
	if err := s.ChangePassword(alice, "pass123", "newpass1"); err != nil {
		t.Fatalf("change password: %v", err)
	}
	if err := s.ChangePassword(alice, "wrongold", "another1"); err != ErrCredentials {
		t.Fatalf("wrong old password should fail: %v", err)
	}
	if _, _, err := s.Login("alice", "newpass1"); err != nil {
		t.Fatalf("login with new password: %v", err)
	}
}
