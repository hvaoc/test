#!/usr/bin/env bash
# Shared environment for the mobile build / run / E2E scripts.
# `source` this from the other scripts. Sets the paths that are NOT on the default
# shell PATH but ARE installed on this machine (the thing my first recon missed):
#   - full Xcode (xcode-select points at CommandLineTools, so tools that shell out to
#     simctl/xcodebuild need DEVELOPER_DIR to find the real Xcode).
#   - the Android SDK (installed under ~/Library/Android/sdk, ANDROID_HOME unset by default).
#   - the Maestro CLI (installed under ~/.maestro/bin).
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$PATH:$HOME/.maestro/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin"
export MAESTRO_CLI_NO_ANALYTICS=1
export ANDROID_AVD="${ANDROID_AVD:-things_avd}"

# Repo root (parent of scripts/).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT
