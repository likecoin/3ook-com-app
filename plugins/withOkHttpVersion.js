const { withAppBuildGradle } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

// OkHttp 4.12.1 blocks the compromised eMudhra intermediate CAs in-client,
// covering devices whose trust store has not been patched yet.
// React Native pins 4.9.2 and our dependencies resolve to 4.12.0; the BOM raises them as a floor.
const OKHTTP_VERSION = '4.12.1';

module.exports = function withOkHttpVersion(config) {
  return withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = mergeContents({
      src: modConfig.modResults.contents,
      newSrc: `    implementation platform('com.squareup.okhttp3:okhttp-bom:${OKHTTP_VERSION}')`,
      tag: 'okhttp-version',
      anchor: /^dependencies \{/m,
      offset: 1,
      comment: '//',
    }).contents;
    return modConfig;
  });
};
