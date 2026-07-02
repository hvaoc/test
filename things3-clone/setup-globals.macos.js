// react-native-macos + Expo: install React Native's core globals (FormData,
// XMLHttpRequest, fetch, Blob, timers, …) BEFORE Expo's "winter" runtime runs —
// it patches `FormData` on load and throws if the global isn't there yet. On
// iOS/Android Expo orders this itself; the out-of-tree macOS platform doesn't.
// (Metro's macos resolver maps `react-native` → `react-native-macos`.)
import 'react-native/Libraries/Core/InitializeCore';
