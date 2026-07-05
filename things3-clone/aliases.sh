#!/usr/bin/env bash
# things3-clone dev aliases.
#
# Use once:      source aliases.sh
# Make permanent (add to ~/.zshrc or ~/.bashrc):
#   source /Users/madd/Projects/shots/test/things3-clone/aliases.sh
#
# Then run:  tc-help   to list everything.

# Resolve this file's own directory (the app root), in both zsh and bash.
_TC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"

# ---- run the stack -----------------------------------------------------------
# Sync server (persistent data in ./ysync-data, email via MailPit, invite links -> web app).
alias tc-server="cd '$_TC_DIR/desktop' && go run ./cmd/ysync-server -addr :8090 -data ./ysync-data -smtp localhost:1025 -app-url http://localhost:8081"
# MailPit dev mail server (SMTP :1025, inbox http://localhost:8025).
alias tc-mail="mailpit"
# Start MailPit (background) + the sync server (foreground) in one go.
alias tc-up="(mailpit >/tmp/mailpit.log 2>&1 &) ; sleep 1 && cd '$_TC_DIR/desktop' && go run ./cmd/ysync-server -addr :8090 -data ./ysync-data -smtp localhost:1025 -app-url http://localhost:8081"
# Open the MailPit inbox in a browser.
alias tc-inbox="open http://localhost:8025"

# ---- the app -----------------------------------------------------------------
alias tc-web="cd '$_TC_DIR' && npm run web"            # web app (http://localhost:8081)
alias tc-desktop="cd '$_TC_DIR' && npm run desktop"    # build the macOS app (signs + notarizes)
alias tc-run="cd '$_TC_DIR' && npm run desktop:run"    # launch the built macOS app

# ---- testing helpers ---------------------------------------------------------
# Mint a tenant-scoped sync token:  tc-token <username> <password> [workspace]
alias tc-token="cd '$_TC_DIR/desktop' && bash scripts/get-sync-token.sh"
# Simulate a teammate (presence/carets):  tc-sim <SYNC_TOKEN> [name]
alias tc-sim="cd '$_TC_DIR/desktop' && node scripts/sim-teammate.mjs"
# Run the Go test suite.
alias tc-test="cd '$_TC_DIR/desktop' && go test ./..."

# ---- housekeeping ------------------------------------------------------------
# Stop the sync server + MailPit.
alias tc-stop="for p in 8090 1025 8025; do lsof -ti:\$p 2>/dev/null | xargs kill 2>/dev/null; done; echo 'stopped sync server + MailPit'"
# List these aliases.
alias tc-help="grep -E \"^alias tc-\" '$_TC_DIR/aliases.sh' | sed -E \"s/^alias (tc-[a-z]+)=.*/  \\1/\" ; echo '  (see aliases.sh for what each runs)'"

echo "things3-clone aliases loaded (tc-*). Run 'tc-help' to list them."
