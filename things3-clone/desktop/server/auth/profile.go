package auth

import (
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// Profile is a user's account info (never includes the password hash).
type Profile struct {
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
}

func (s *Store) profileLocked(uid string) Profile {
	u := s.d.Users[uid]
	if u == nil {
		return Profile{UserID: uid}
	}
	return Profile{UserID: u.ID, Username: u.Username, Email: u.Email, DisplayName: u.DisplayName}
}

// displayNameLocked returns a user's best human name (display name, else username).
func (s *Store) displayNameLocked(uid string) string {
	u := s.d.Users[uid]
	if u == nil {
		return "someone"
	}
	if u.DisplayName != "" {
		return u.DisplayName
	}
	return u.Username
}

// GetProfile returns the user's account info.
func (s *Store) GetProfile(userID string) Profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.profileLocked(userID)
}

// UpdateProfile sets the display name and email.
func (s *Store) UpdateProfile(userID, displayName, email string) (Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.d.Users[userID]
	if u == nil {
		return Profile{}, ErrNotFound
	}
	u.DisplayName = strings.TrimSpace(displayName)
	u.Email = strings.TrimSpace(email)
	s.saveLocked()
	return s.profileLocked(userID), nil
}

// ChangePassword verifies the current password and sets a new one.
func (s *Store) ChangePassword(userID, oldPw, newPw string) error {
	if len(newPw) < 6 {
		return ErrWeakPassword
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.d.Users[userID]
	if u == nil {
		return ErrNotFound
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PassHash), []byte(oldPw)) != nil {
		return ErrCredentials
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPw), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	u.PassHash = string(hash)
	s.saveLocked()
	return nil
}
