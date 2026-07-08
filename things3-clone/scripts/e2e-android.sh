#!/usr/bin/env bash
# Run the Maestro E2E flows on the running Android emulator.
# Assumes the app is installed (run ./scripts/run-android.sh once first).
#   ./scripts/e2e-android.sh                   # all flows
#   ./scripts/e2e-android.sh task-crud         # one flow
set -euo pipefail
source "$(dirname "$0")/mobile-env.sh"

if ! adb devices | grep -qw device; then
  echo "No Android emulator running. Run ./scripts/run-android.sh first." >&2
  exit 1
fi

if [ "${1:-}" ]; then
  exec maestro test "$ROOT/.maestro/flows/$1.yaml"
fi
exec maestro test "$ROOT/.maestro/flows"
