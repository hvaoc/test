# Production build sizes, per platform

Measured build sizes for the app across all four tiers, and how much of each is the
shared Go `core/record` engine (via gomobile) vs the app itself. Numbers are from
release/production builds on this machine (Expo SDK 54 / RN 0.81, New Architecture).

> How to reproduce each build is at the bottom.

---

## Summary

| Platform | Production artifact | Size | Notes |
|---|---|---:|---|
| **Web** | `expo export` bundle (`dist-web`) | **13 MB** on disk · **~2.0 MB gzipped over the wire** | dominated by a droppable legacy `crdt.wasm` |
| **iOS** | `.app` (Release) | **86 MB** (simulator, fat) | a device `.ipa` thins to one arch + App Store compression |
| **Android** | `.apk` (universal, Release) | **123 MB** universal · **AAB 97 MB** · **~57 MB install / ~42 MB download per device** (arm64) | native `.so`s dominate; Play delivers only the device's ABI |
| **Desktop** | Wails `.app` (macOS, signed + notarized) | **22 MB** | one Go binary with embedded web assets; WebKit is a system framework |

The single biggest line item on native is the **gomobile Go engine** (`libgojni.so`),
which packs the Go runtime + `modernc.org/sqlite` + `ygo` + `core/record`:

| Engine artifact | Size |
|---|---:|
| `libgojni.so` per Android ABI (**Release**, measured) | **~10.5 MB** (arm64) |
| `libgojni.so` per Android ABI (debug) | ~15 MB |
| Go engine inside the iOS binary (per slice, static) | **~27 MB** |
| `RecordMobile.xcframework` (iOS, device + sim = 3 slices) | 81 MB |
| `RecordMobile.aar` (Android, 4 ABIs) | 35 MB |

---

## Web

`expo export --platform web` → `dist-web` — **13 MB** on disk:

| Asset | Size | Role |
|---|---:|---|
| main JS bundle | 2.9 MB (**0.7 MB gzipped**) | the app |
| `crdt.wasm` | 5.1 MB | **active** ygo whole-workspace CRDT engine — web's persistence + sync path (`crdt.worker.js`) |
| `sqlite3.wasm` | 896 KB | record-layer engine (sqlite.wasm) — additive query/search mirror |
| `sqlite3.js` | 384 KB | sqlite.wasm JS glue |
| `record.worker.js` | 20 KB | the RecordStore worker |

**Over-the-wire is what matters:** the app JS is ~0.7 MB gzipped, and the wasm
assets (~1.3 MB) load lazily in their workers.

> **`crdt.wasm` is not removable today.** It is the live web CRDT engine that backs
> `loadSnapshot`/`saveSnapshot`/`sync` (`backend.js` → `wasmWebAdapter` → `crdtClient`
> → `crdt.worker.js`). The sqlite.wasm record layer is an *additive* read-only query
> mirror, **not** a replacement, and the pure-JS fallback speaks a different (op-log)
> wire protocol, so it isn't an interchangeable replica. `crdt.wasm` only becomes
> droppable once the web path is migrated off the whole-workspace ygo doc onto the
> record layer + per-task text docs — the same migration mobile/desktop are staged for
> (see `docs/architecture-1m.md`). Until then, cutting it breaks web persistence + sync.

## iOS

Release `.app` (simulator): **86 MB**, broken down:

| Part | Size |
|---|---:|
| main binary (app + `RecordNative` + Go engine, **static-linked**) | 43 MB |
| Frameworks (Hermes, React, etc.) | 33 MB |
| Hermes JS bundle | 5.3 MB |

The Go record engine is statically linked into the main binary (no separate
framework in the bundle). This is a **simulator** build (fatter); a real device
`.ipa` is a single `arm64` slice, and App Store delivery thins + compresses it
further — expect materially smaller on-device.

## Android

All numbers below are **measured** from the actual Release build (`assembleRelease` +
`bundleRelease`, R8 enabled).

- **Release universal APK: 123 MB** — carries **all four ABIs** (`arm64-v8a`,
  `armeabi-v7a`, `x86`, `x86_64`). Each ABI's native libs are ~22–29 MB, so the four
  copies are the bulk of the file. This is the sideload/CI artifact, **not** the
  user-facing number.
- **Release AAB: 97 MB** — what you upload to Play. It contains all ABIs too; Play
  splits it per device on download.
- **Per-device (measured from the APK's contents):**

  | Device ABI | `libgojni.so` | install on disk | download |
  |---|---:|---:|---:|
  | **arm64-v8a** (modern phones) | 10.5 MB | **56.6 MB** | **~42 MB** |
  | armeabi-v7a (old 32-bit) | 10.4 MB | 51.1 MB | ~36 MB |
  | x86_64 (emulator) | 11.0 MB | 57.7 MB | ~43 MB |

  Per device = **shared (28.8 MB dex + resources + assets, ~14 MB compressed)** + **one
  ABI's native libs** (not all four). `libgojni.so` — the entire Go/`core/record`/`ygo`
  engine — is only **~10.5 MB** in Release (Go strips harder than the ~15 MB debug lib).
- **Production recommendation — ship the AAB.** Play delivers one ABI, so a modern phone
  downloads **~42 MB** and installs **~57 MB**, not the 123 MB universal. Play's own
  re-compression trims the download further.

> Note: AGP stores native `.so`s **uncompressed inside the APK** (`extractNativeLibs=false`,
> for faster startup + smaller install delta), so the per-ABI libs don't shrink within the
> APK — but Play re-compresses them for over-the-wire delivery.

## Desktop (Wails, macOS)

Release `.app` (arm64, Developer-ID signed + Apple-notarized): **22 MB**, essentially
all of it one file:

| Part | Size |
|---|---:|
| main binary (`Contents/MacOS/Things Clone`) | 22 MB |
| Resources (just `iconfile.icns`) | 36 KB |
| bundled frameworks | 0 — **WebKit is a system framework** |

Wails **embeds the `dist-web` export directly into the Go binary** (Go `embed`), so
there are no loose web assets in the bundle — the 22 MB binary is `core/record` +
`ygo` + the Wails/WebKit bindings + the Go runtime + the embedded web app. This is the
**leanest native tier**: because it reuses the OS WebKit and static-links one Go binary
(no per-ABI duplication, no Hermes/React Native frameworks), it's ~4× smaller than the
mobile `.app`/APK.

---

## Takeaways

- The **Go engine (`libgojni.so`, ~10.5 MB/ABI in Release)** is the dominant native
  cost. It's the price of one shared, bullet-proof CRDT engine across platforms;
  per-device delivery (AAB on Android, thinning on iOS) keeps what users actually
  download reasonable (~42 MB on a modern Android phone). Desktop pays it once as a
  22 MB static binary.
- **Web is the lean tier** (~0.7 MB gz app + ~1.3 MB wasm on demand). `crdt.wasm`
  (5 MB) is the one big line item, but it's the **active** web CRDT engine, not dead
  weight — it comes off only after the web path migrates onto the record layer.
- Debug artifacts (universal APK, simulator `.app`) are **not** representative of what
  ships; always quote AAB/device-thinned sizes for user-facing numbers.

## Reproduce

```bash
# Web (production bundle)
cd things3-clone && npx expo export --platform web --output-dir dist-web && du -sh dist-web

# iOS (Release .app; device archive for a real .ipa)
cd things3-clone && npx expo run:ios --configuration Release
#   → ~/Library/Developer/Xcode/DerivedData/ThingsClone-*/Build/Products/Release-*/ThingsClone.app

# Android (release APK, and the AAB you'd actually ship)
cd things3-clone/android && ./gradlew assembleRelease   # app/build/outputs/apk/release/
cd things3-clone/android && ./gradlew bundleRelease      # app/build/outputs/bundle/release/  (per-device sizes)

# Desktop (Wails macOS .app)
cd things3-clone && npm run desktop
```
