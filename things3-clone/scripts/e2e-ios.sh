#!/usr/bin/env bash
# Run the Maestro E2E flows on the booted iOS Simulator.
# Assumes the app is already installed (run ./scripts/run-ios.sh once first).
#   ./scripts/e2e-ios.sh                       # all flows
#   ./scripts/e2e-ios.sh smart-lists           # one flow
set -euo pipefail
source "$(dirname "$0")/mobile-env.sh"

if ! xcrun simctl list devices booted | grep -q "(Booted)"; then
  echo "No iOS simulator booted. Run ./scripts/run-ios.sh first." >&2
  exit 1
fi

if [ "${1:-}" ]; then
  exec maestro test "$ROOT/.maestro/flows/$1.yaml"
fi
exec maestro test "$ROOT/.maestro/flows"
