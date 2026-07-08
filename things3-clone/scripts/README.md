# Build / run / test scripts

One-liners for building and running the app on simulators/emulators and running the E2E
suites. All the non-obvious environment (full-Xcode `DEVELOPER_DIR`, `ANDROID_HOME`, the
Maestro CLI path) lives in `mobile-env.sh`, which every script sources — so you don't have
to remember it. Also exposed as npm scripts (see below).

| Command | What it does |
|---------|--------------|
| `./scripts/run-ios.sh` / `npm run sim:ios` | Boot an iPhone simulator (if needed), build, install, launch the app |
| `./scripts/run-android.sh` / `npm run emu:android` | Boot the `things_avd` emulator (if needed), build, install, launch |
| `./scripts/e2e-ios.sh [flow]` / `npm run e2e:ios` | Run Maestro flows on the booted iOS sim (all, or one: `e2e-ios.sh task-crud`) |
| `./scripts/e2e-android.sh [flow]` / `npm run e2e:android` | Run Maestro flows on the Android emulator |
| `./scripts/e2e-web.sh` / `npm run e2e:web` | Run the Playwright web suite (needs `npm run web` serving on :8088) |

## Prereqs (already installed on this machine)
- **Xcode** at `/Applications/Xcode.app` (full, not just Command Line Tools). `mobile-env.sh`
  sets `DEVELOPER_DIR` so `simctl`/`xcodebuild`/Maestro find it even though `xcode-select`
  points at the CLT.
- **Android SDK** at `~/Library/Android/sdk` with an AVD named `things_avd`.
- **Maestro** at `~/.maestro/bin` (install: `curl -fsSL https://get.maestro.mobile.dev | bash`).
- **Node/Expo** for `npx expo run:ios|android`.

## Typical loop
```bash
npm run sim:ios          # build + launch on iOS Simulator (once)
npm run e2e:ios          # run all Maestro flows against it
npm run e2e:ios task-crud  # or a single flow

npm run emu:android      # build + launch on Android Emulator (once)
npm run e2e:android      # run all Maestro flows against it

npm run web & npm run e2e:web   # web: serve + Playwright
```

## Notes
- iOS `run-ios.sh` respects `IOS_SIM` (default "iPhone 17").
- Android `run-android.sh`/e2e respect `ANDROID_AVD` (default `things_avd`).
- Maestro targets whatever single device is booted; boot only one platform at a time, or
  pass `maestro --device <id> test ...` manually.
