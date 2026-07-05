package mail

import "fmt"

// VerifyEmail builds the subject + HTML + text for an email-verification message.
func VerifyEmail(name, verifyURL string) (subject, html, text string) {
	if name == "" {
		name = "there"
	}
	subject = "Verify your PlayTasks email"
	text = fmt.Sprintf(
		"Hi %s,\n\nConfirm your email to finish setting up your PlayTasks account:\n%s\n\n"+
			"If you didn't sign up, you can ignore this email.",
		name, verifyURL)
	html = fmt.Sprintf(`<!doctype html>
<html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1c1e">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
    <div style="background:#2b6fff;padding:22px 28px;color:#fff;font-size:18px;font-weight:700">PlayTasks</div>
    <div style="padding:28px">
      <p style="font-size:16px;margin:0 0 12px">Hi %s, confirm your email to finish creating your account.</p>
      <a href="%s" style="display:inline-block;background:#2b6fff;color:#fff;text-decoration:none;
        font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">Verify email</a>
      <p style="font-size:12px;color:#999;margin:24px 0 0;word-break:break-all">Or paste this link:<br>%s</p>
    </div>
  </div>
  <p style="text-align:center;color:#aaa;font-size:11px">If you didn't sign up, you can ignore this email.</p>
</body></html>`, name, verifyURL, verifyURL)
	return subject, html, text
}

// InviteEmail builds the subject + HTML + plain-text bodies for a workspace
// invitation.
func InviteEmail(inviter, workspace, joinURL string) (subject, html, text string) {
	if inviter == "" {
		inviter = "A teammate"
	}
	subject = fmt.Sprintf("%s invited you to the %q workspace", inviter, workspace)

	text = fmt.Sprintf(
		"%s invited you to join the \"%s\" workspace on PlayTasks.\n\n"+
			"Open this link to accept:\n%s\n\n"+
			"If you didn't expect this, you can ignore this email.",
		inviter, workspace, joinURL)

	html = fmt.Sprintf(`<!doctype html>
<html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1c1e">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
    <div style="background:#2b6fff;padding:22px 28px;color:#fff;font-size:18px;font-weight:700">PlayTasks</div>
    <div style="padding:28px">
      <p style="font-size:16px;margin:0 0 12px"><b>%s</b> invited you to collaborate in the
        <b>%s</b> workspace.</p>
      <p style="font-size:14px;color:#666;margin:0 0 24px">Tasks, notes, and edits sync live between everyone in the workspace.</p>
      <a href="%s" style="display:inline-block;background:#2b6fff;color:#fff;text-decoration:none;
        font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">Accept invitation</a>
      <p style="font-size:12px;color:#999;margin:24px 0 0;word-break:break-all">Or paste this link:<br>%s</p>
    </div>
  </div>
  <p style="text-align:center;color:#aaa;font-size:11px">If you didn't expect this, you can ignore this email.</p>
</body></html>`, inviter, workspace, joinURL, joinURL)

	return subject, html, text
}
