// Explicit Metro config so BOTH bundlers use Expo's setup:
//   - Expo CLI (iOS / Android / web)        -> `npx expo start`
//   - RN Community CLI (macOS / Windows)     -> `react-native run-windows`
// Extending expo/metro-config keeps Expo modules + babel-preset-expo working
// no matter which CLI starts Metro. This is identical to Expo's built-in
// default, so it changes nothing for the existing iOS/Android/web workflow.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

module.exports = config;
