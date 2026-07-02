// Explicit Metro config so BOTH bundlers use Expo's setup:
//   - Expo CLI (iOS / Android / web)        -> `npx expo start`
//   - RN Community CLI (macOS / Windows)     -> `react-native run-windows`
// Extending expo/metro-config keeps Expo modules + babel-preset-expo working
// no matter which CLI starts Metro. This is identical to Expo's built-in
// default, so it changes nothing for the existing iOS/Android/web workflow.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Let Metro resolve + serve the `macos` platform (react-native-macos) too, so a
// Debug macOS build can load its bundle from the same dev server. Harmless for
// iOS/Android/web — it only enables `.macos.js` resolution.
config.resolver.platforms = Array.from(
  new Set([...(config.resolver.platforms || ['ios', 'android', 'native', 'web']), 'macos'])
);

// For the `macos` platform, redirect `react-native` imports to
// `react-native-macos` (the out-of-tree fork), the way a react-native-macos
// project's own Metro config does. Other platforms are untouched.
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform === 'macos' &&
    (moduleName === 'react-native' || moduleName.startsWith('react-native/'))
  ) {
    const redirected = 'react-native-macos' + moduleName.slice('react-native'.length);
    return context.resolveRequest(context, redirected, platform);
  }
  return upstreamResolveRequest
    ? upstreamResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
