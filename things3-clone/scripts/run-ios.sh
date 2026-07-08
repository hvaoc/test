#!/usr/bin/env bash
# Build + install + launch the app on an iOS Simulator.
#   ./scripts/run-ios.sh            # boots a sim if needed, builds, installs, launches
#   IOS_SIM="iPhone 17" ./scripts/run-ios.sh
set -euo pipefail
source "$(dirname "$0")/mobile-env.sh"

SIM="${IOS_SIM:-iPhone 17}"

# Ensure a simulator is booted (Maestro/expo target the booted device).
if ! xcrun simctl list devices booted | grep -q "(Booted)"; then
  echo "Booting simulator: $SIM"
  xcrun simctl boot "$SIM" || true
  open -a Simulator
  # wait until booted
  for _ in $(seq 1 30); do
    xcrun simctl list devices booted | grep -q "(Booted)" && break
    sleep 1
  done
fi

cd "$ROOT"
# expo run:ios compiles the native app (CocoaPods on first run), installs it on the
# booted sim, and launches it. Subsequent runs are incremental.
npx expo run:ios
