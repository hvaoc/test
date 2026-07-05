package auth

import (
	"strings"

	"things3-clone-desktop/server/mail"

	"golang.org/x/crypto/bcrypt"
)

// RequestPasswordReset emails a reset link to the account matching `identifier`
// (username or email). It is intentionally silent about whether the account
// exists (no enumeration) — it just tries to send.
func (s *Store) RequestPasswordReset(identifier string) {
	s.mu.Lock()
	uid, ok := s.findUserIDLocked(identifier)
	if !ok {
		s.mu.Unlock()
		return
	}
	u := s.d.Users[uid]
	if u == nil || u.Email == "" {
		s.mu.Unlock()
		return // no address to send to
	}
	code := token()
	s.d.Resets[code] = uid
	name, email, url, mailer := u.Username, u.Email, s.appURL+"/?reset="+code, s.mailer
	s.saveLocked()
	s.mu.Unlock()

	if mailer != nil {
		subject, html, text := mail.ResetEmail(name, url)
		_ = mailer.Send(email, subject, html, text)
	}
}

// ResetPassword sets a new password using a reset code and consumes it (plus any
// other outstanding reset codes for that user). Returns the user id.
func (s *Store) ResetPassword(code, newPassword string) (string, error) {
	if len(newPassword) < 6 {
		return "", ErrWeakPassword
	}
	code = strings.TrimSpace(code)
	s.mu.Lock()
	defer s.mu.Unlock()
	uid, ok := s.d.Resets[code]
	if !ok {
		return "", ErrNotFound
	}
	u := s.d.Users[uid]
	if u == nil {
		return "", ErrNotFound
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	u.PassHash = string(hash)
	for c, id := range s.d.Resets {
		if id == uid {
			delete(s.d.Resets, c)
		}
	}
	s.saveLocked()
	return uid, nil
}
