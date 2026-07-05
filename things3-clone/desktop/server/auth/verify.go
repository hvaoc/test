package auth

import "things3-clone-desktop/server/mail"

// Verify marks the account owning `code` as email-verified and consumes the code.
// Public — the code itself is the proof. Returns the user id.
func (s *Store) Verify(code string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	uid, ok := s.d.Verify[code]
	if !ok {
		return "", ErrNotFound
	}
	if u := s.d.Users[uid]; u != nil {
		u.Verified = true
	}
	// Consume this code and any other outstanding codes for the same user.
	for c, id := range s.d.Verify {
		if id == uid {
			delete(s.d.Verify, c)
		}
	}
	s.saveLocked()
	return uid, nil
}

// ResendVerification issues a fresh code + email for an unverified account.
func (s *Store) ResendVerification(userID string) error {
	s.mu.Lock()
	u := s.d.Users[userID]
	if u == nil || u.Email == "" {
		s.mu.Unlock()
		return ErrNotFound
	}
	if u.Verified {
		s.mu.Unlock()
		return nil
	}
	code := token()
	s.d.Verify[code] = u.ID
	name, email, url, mailer := u.Username, u.Email, s.appURL+"/?verify="+code, s.mailer
	s.saveLocked()
	s.mu.Unlock()

	if mailer != nil {
		subject, html, text := mail.VerifyEmail(name, url)
		return mailer.Send(email, subject, html, text)
	}
	return nil
}
