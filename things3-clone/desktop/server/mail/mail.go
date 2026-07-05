// Package mail sends transactional email (workspace invitations). In development
// it points at MailPit (an SMTP sink with a web inbox on :8025); in production
// swap the SMTP host for a real relay — same interface.
package mail

import (
	"fmt"
	"log"
	"net/smtp"
	"strings"
)

// Mailer sends one message. Implementations must be safe for concurrent use.
type Mailer interface {
	Send(to, subject, htmlBody, textBody string) error
}

// SMTPMailer sends via a plain SMTP server with no auth (MailPit in dev). For a
// real relay, extend with auth/TLS.
type SMTPMailer struct {
	Addr string // host:port, e.g. "localhost:1025"
	From string // From address, e.g. "PlayTasks <no-reply@playtasks.local>"
}

func (m *SMTPMailer) Send(to, subject, htmlBody, textBody string) error {
	from := m.From
	if from == "" {
		from = "PlayTasks <no-reply@playtasks.local>"
	}
	// A minimal multipart/alternative message (text + HTML).
	boundary := "b1a2c3d4e5"
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", subject)
	b.WriteString("MIME-Version: 1.0\r\n")
	fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=%q\r\n\r\n", boundary)
	fmt.Fprintf(&b, "--%s\r\n", boundary)
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
	b.WriteString(textBody + "\r\n")
	fmt.Fprintf(&b, "--%s\r\n", boundary)
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
	b.WriteString(htmlBody + "\r\n")
	fmt.Fprintf(&b, "--%s--\r\n", boundary)

	fromAddr := from
	if i := strings.LastIndexByte(from, '<'); i >= 0 {
		fromAddr = strings.TrimSuffix(strings.TrimSpace(from[i+1:]), ">")
	}
	return smtp.SendMail(m.Addr, nil, fromAddr, []string{to}, []byte(b.String()))
}

// LogMailer just logs instead of sending (used when no SMTP host is configured),
// so invites still work via link/QR without a mail server.
type LogMailer struct{}

func (LogMailer) Send(to, subject, _ , _ string) error {
	log.Printf("mail: (no SMTP configured) would send %q to %s", subject, to)
	return nil
}
