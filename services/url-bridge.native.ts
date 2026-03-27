import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import type { BridgeHandlerMap } from './bridge-dispatcher';

export function getURLHandlers(): BridgeHandlerMap {
  return {
    openExternalURL: async (msg) => {
      const url = msg.url as string;
      if (!url) return;

      try {
        if (url.startsWith('mailto:') || url.startsWith('tel:')) {
          await Linking.openURL(url);
        } else {
          await WebBrowser.openBrowserAsync(url, {
            dismissButtonStyle: 'close',
            presentationStyle:
              WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
          });
        }
      } catch (e) {
        console.warn('[openExternalURL]', e);
      }
    },
  };
}
