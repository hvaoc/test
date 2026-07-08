#!/usr/bin/env bash
# Boot the Android emulator (AVD `things_avd`) + build + install + launch the app.
#   ./scripts/run-android.sh
#   ANDROID_AVD=Pixel_7 ./scripts/run-android.sh
set -euo pipefail
source "$(dirname "$0")/mobile-env.sh"

# Start the emulator if no device is attached.
if ! adb devices | grep -qw device; then
  echo "Starting Android emulator: $ANDROID_AVD"
  nohup emulator -avd "$ANDROID_AVD" -no-snapshot-save -no-audio >/tmp/android-emulator.log 2>&1 &
  adb wait-for-device
  echo -n "Waiting for boot to complete"
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    echo -n "."; sleep 2
  done
  echo " done"
fi

cd "$ROOT"
# expo run:android runs the Gradle build, installs the APK on the running emulator,
# and launches it. First build is slow (Gradle + NDK); later builds are incremental.
npx expo run:android
