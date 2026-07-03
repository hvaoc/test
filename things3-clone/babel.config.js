module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Reanimated 4's worklet transform (moved to react-native-worklets). Must be
    // listed LAST.
    plugins: ['react-native-worklets/plugin'],
  };
};
