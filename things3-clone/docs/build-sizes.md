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
| **Android** | `.apk` (universal) | debug **89 MB** · release universal similar order | native `.so`s dominate; an **AAB** ships ~1 ABI (**~30–35 MB/device**) |
| **Desktop** | Wails `.app` (macOS) | _not built this run_ | Go binary + embedded web assets; WebKit is the system framework |

The single biggest line item on native is the **gomobile Go engine** (`libgojni.so`),
which packs the Go runtime + `modernc.org/sqlite` + `ygo` + `core/record`:

| Engine artifact | Size |
|---|---:|
| `libgojni.so` per Android ABI | **~15 MB** |
| Go engine inside the iOS binary (per slice, static) | **~27 MB** |
| `RecordMobile.xcframework` (iOS, device + sim = 3 slices) | 81 MB |
| `RecordMobile.aar` (Android, 4 ABIs) | 35 MB |

---

## Web

`expo export --platform web` → `dist-web` — **13 MB** on disk:

| Asset | Size | Role |
|---|---:|---|
| main JS bundle | 2.9 MB (**0.7 MB gzipped**) | the app |
| `crdt.wasm` | 5.1 MB | **legacy** ygo whole-doc engine — droppable once the transitional blob path is removed |
| `sqlite3.wasm` | 896 KB | record-layer engine (sqlite.wasm) |
| `sqlite3.js` | 384 KB | sqlite.wasm JS glue |
| `record.worker.js` | 20 KB | the RecordStore worker |

**Over-the-wire is what matters:** the app JS is ~0.7 MB gzipped, and the wasm
assets (~1.3 MB) load lazily in the worker. Removing the legacy `crdt.wasm` (5.1 MB)
is the biggest easy win once the ygo blob path is retired.

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

- **Debug (universal) APK:** 89 MB (measured) — carries **all four ABIs**, and each
  ABI includes a ~15 MB `libgojni.so`, so the Go engine alone is ~60 MB of that.
- **Release (universal) APK:** the same order of magnitude — R8 minifies the
  Java/Kotlin/dex (a few MB) but **not** the native `.so`s, which dominate the size.
  A universal release is therefore *not* the number to quote for users.
- **Production recommendation — ship an AAB** (`./gradlew bundleRelease`): Google Play
  delivers only the device's ABI, so a phone downloads **~1×** `libgojni.so` (~15 MB)
  plus the other native libs + dex ≈ **~30–35 MB/device**, not the ~60 MB of engine
  across all ABIs. That's the real user-facing size.

## Desktop (Wails, macOS)

Not built in this run. A Wails `.app` bundles the **Go binary** (which includes
`core/record` + `ygo` + the Wails/WebKit bindings) plus the **embedded web assets**
(the `dist-web` export). macOS **WebKit is a system framework** (not bundled), so the
`.app` is roughly *Go binary + web assets* — build with `npm run desktop` to measure.

---

## Takeaways

- The **Go engine (`libgojni.so`, ~15 MB/ABI)** is the dominant native cost. It's the
  price of one shared, bullet-proof CRDT engine across platforms; per-device delivery
  (AAB on Android, thinning on iOS) keeps what users actually download reasonable.
- **Web is the lean tier** (~0.7 MB gz app + ~1.3 MB wasm on demand) — and dropping
  the legacy `crdt.wasm` removes 5 MB.
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
