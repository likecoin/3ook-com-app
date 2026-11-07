const { withMainActivity } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

// Key events reach the Activity before the focused WebView, and an Expo module
// has no hook there, so MainActivity hands volume keys to modules/volume-keys.
const DISPATCH_KEY_EVENT = `  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    if (expo.modules.volumekeys.VolumeKeysModule.handleKeyEvent(event)) return true
    return super.dispatchKeyEvent(event)
  }`;

module.exports = function withVolumeKeyPaging(config) {
  return withMainActivity(config, (modConfig) => {
    if (modConfig.modResults.language !== 'kt') {
      throw new Error('withVolumeKeyPaging: expected a Kotlin MainActivity');
    }
    modConfig.modResults.contents = mergeContents({
      tag: 'volume-key-paging',
      src: modConfig.modResults.contents,
      newSrc: DISPATCH_KEY_EVENT,
      anchor: /^class MainActivity\b.*\{\s*$/m,
      offset: 1,
      comment: '//',
    }).contents;
    return modConfig;
  });
};
