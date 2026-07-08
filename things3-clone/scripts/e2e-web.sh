#!/usr/bin/env bash
# Run the Playwright web E2E suite. Needs the web app served at PLAYWRIGHT_BASE_URL
# (default http://localhost:8088 — start it with `npm run web`).
#   ./scripts/e2e-web.sh
set -euo pipefail
source "$(dirname "$0")/mobile-env.sh"
cd "$ROOT/e2e"
[ -d node_modules ] || npm install
exec npx playwright test "$@"
