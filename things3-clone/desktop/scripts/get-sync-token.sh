#!/usr/bin/env bash
# Print a tenant-scoped SYNC token for an account (created on first use, exactly
# like the app's sign-in). Use it to run scripts/sim-teammate.mjs against your
# workspace so you can see live presence / remote carets.
#
# Usage:
#   bash scripts/get-sync-token.sh [username] [password]
#   SERVER=http://localhost:8090 bash scripts/get-sync-token.sh me secret1
set -euo pipefail

SERVER="${SERVER:-http://localhost:8090}"
UNAME="${1:-me}"
PASS="${2:-secret1}"

jq_get() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || true; }

# Log in; if that fails (new account), register.
resp=$(curl -s -X POST "$SERVER/v1/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$UNAME\",\"password\":\"$PASS\"}")
token=$(printf '%s' "$resp" | jq_get '.get("token","")')
if [ -z "$token" ]; then
  resp=$(curl -s -X POST "$SERVER/v1/register" -H 'content-type: application/json' \
    -d "{\"username\":\"$UNAME\",\"password\":\"$PASS\"}")
  token=$(printf '%s' "$resp" | jq_get '["token"]')
fi
if [ -z "$token" ]; then
  echo "error: could not sign in. Is the server running at $SERVER?  ($resp)" >&2
  exit 1
fi

tenant=$(printf '%s' "$resp" | jq_get '["tenants"][0]["id"]')
sync=$(curl -s -X POST "$SERVER/v1/synctoken" -H "Authorization: Bearer $token" \
  -H 'content-type: application/json' -d "{\"tenantId\":\"$tenant\"}" | jq_get '["token"]')

echo "SYNC_TOKEN=$sync"
