module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Reanimated 3's worklet transform. Must be listed LAST. (Reanimated 4 used
    // react-native-worklets/plugin; on 3.x this is the correct plugin.)
    plugins: ['react-native-reanimated/plugin'],
  };
};
