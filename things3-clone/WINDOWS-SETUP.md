# Windows (and macOS) desktop — build guide

This app keeps the **Expo** workflow for iOS / Android / web **and** adds native
desktop via Microsoft's [react-native-windows](https://microsoft.github.io/react-native-windows/)
and [react-native-macos](https://microsoft.github.io/react-native-macos/) — the
*bare workflow with Expo modules*. Same `src/`, same JS, four targets.

What's already wired in this repo (done on macOS, verified):

- `react-native-windows@0.81.29` in `dependencies` (matches core `react-native@0.81.5`).
- `@react-native-community/cli@17.0.0` in `devDependencies` (RN-Windows drives the
  community CLI; Expo uses its own CLI, the two coexist).
- `metro.config.js` extends `expo/metro-config` so **both** CLIs bundle through Expo
  (keeps `babel-preset-expo` + Expo modules working under `run-windows`).
- `npm run windows` script.

> Note on React versions: every `react-native-windows@0.81.x` lists `react@^19.1.4`
> as a peer, but Expo SDK 54 pins `react@19.1.0`. That's a patch-level mismatch only
> — there is a single React at runtime (19.1.0). Install with `--legacy-peer-deps`
> (below) so npm doesn't try to bump React and break Expo.

---

## Windows — run on a Windows 10/11 machine

RN-Windows builds with MSBuild — it **cannot** be built on macOS/Linux. Do this on Windows.

### 1. Prerequisites
Install the dev dependencies per the official guide:
<https://microsoft.github.io/react-native-windows/docs/rnw-dependencies>
(Visual Studio 2022 with the **Desktop development with C++**, **Universal Windows
Platform development**, and **.NET desktop** workloads; the Windows 10/11 SDK; Node LTS.)

### 2. Install JS deps
```powershell
cd things3-clone
npm install --legacy-peer-deps
```

### 3. Generate the native `windows/` project
```powershell
npx react-native init-windows --overwrite --logging
```
This creates `windows/` (the Visual Studio solution) and autolinks native modules.

### 4. Point the native app at the Expo-registered root  ⚠️ required
`index.js` uses Expo's `registerRootComponent`, which registers the root component
under the name **`main`** (not the app name). After `init-windows`, open the generated
app entry and set the main component name to `main`:

- **C++ template** — `windows/<AppName>/App.cpp`:
  ```cpp
  InitialProps().MainComponentName(L"main");
  ```
- **C# template** — `windows/<AppName>/App.xaml.cs`:
  ```csharp
  MainComponentName = "main";
  ```
Otherwise the window loads but stays blank (native asks for a module name that JS
never registered).

### 5. Build + run
```powershell
npx react-native run-windows
```
Metro starts via `metro.config.js` (Expo config), so `babel-preset-expo` and the
Expo modules resolve the same as on mobile.

---

## macOS — run on this Mac (needs Xcode + CocoaPods)

```bash
cd things3-clone
npx react-native-macos-init            # generates macos/  (use the 0.81 line)
npx install-expo-modules@latest        # adds use_expo_modules! to the Podfile
cd macos && pod install && cd ..
# set MainComponentName to "main" in macos/<AppName>/AppDelegate (same reason as step 4)
npx react-native run-macos
```

---

## Caveats worth knowing

- **Expo-module support on Windows is limited/experimental** (it's strong on
  Apple platforms). This app's modules are lightweight — `expo-status-bar`
  (near no-op off-iOS), `@expo/vector-icons` (fonts + JS), `expo-asset` /
  `expo-font` (mostly JS) — so they should load, but if one fails to autolink on
  Windows, guard it with `Platform.OS` and a JS fallback.
- **`expo-haptics` is in `package.json` but unused in `src/`** — no desktop concern.
- **`Alert.alert` with buttons** (delete-project confirm in
  `src/components/ProjectHeader.js`) is iOS/Android-only; on web/desktop it
  degrades. Swap for a custom modal if you need the confirm on desktop.
- Keep using `npx expo start` for iOS/Android/web; use `run-windows` / `run-macos`
  for desktop. Both share the same Metro/Babel config.
