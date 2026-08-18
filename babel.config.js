// Required by @reown/appkit-react-native (valtio uses import.meta on Expo 53+).
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
  };
};
