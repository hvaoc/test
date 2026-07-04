#!/usr/bin/env bash
# Build the shared Go data engine (embedded SQLite + sync) into native mobile
# libraries with gomobile, so the iOS and Android apps run the SAME backend as
# the Wails desktop build.
#
# Prerequisites (one-time):
#   go install golang.org/x/mobile/cmd/gomobile@latest
#   gomobile init
#   # iOS: Xcode + command line tools.  Android: Android SDK + NDK, ANDROID_HOME set.
#
# Output:
#   ios/Playdata.xcframework   → drag into the iOS project (or via CocoaPods)
#   android/playdata.aar       → put in android/app/libs/
#
# Run from this directory:  ./build-mobile.sh [ios|android|all]
set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:-all}"
PKG="./mobile"
OUT_IOS="../mobile-bind/ios/Playdata.xcframework"
OUT_ANDROID="../mobile-bind/android/playdata.aar"

mkdir -p ../mobile-bind/ios ../mobile-bind/android

if ! command -v gomobile >/dev/null 2>&1; then
  echo "gomobile not found. Install it first:"
  echo "  go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init"
  exit 1
fi

build_ios() {
  echo "▸ Building iOS xcframework → $OUT_IOS"
  gomobile bind -target=ios -o "$OUT_IOS" "$PKG"
}

build_android() {
  echo "▸ Building Android aar → $OUT_ANDROID"
  gomobile bind -target=android -androidapi 24 -o "$OUT_ANDROID" "$PKG"
}

case "$TARGET" in
  ios) build_ios ;;
  android) build_android ;;
  all) build_ios; build_android ;;
  *) echo "usage: $0 [ios|android|all]"; exit 1 ;;
esac

echo "✓ Done. Wire the library up with the React Native native modules in mobile/reactnative/."
