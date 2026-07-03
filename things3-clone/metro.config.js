// Expo's default Metro config (iOS / Android / web). Desktop ships as the web
// build wrapped in Wails, so there are no out-of-tree native platforms to wire.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
