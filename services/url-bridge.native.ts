import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import type { BridgeHandlerMap } from './bridge-dispatcher';

const DEEP_LINK_SCHEME_RE =
  /^(mailto:|tel:|wc:|metamask:|cbwallet:|rainbow:|trust:)/;

const WALLET_UNIVERSAL_LINK_PREFIXES = [
  'https://metamask.app.link/',
  'https://go.cb-w.com/',
  'https://link.trustwallet.com/',
];

/** Returns true for URLs that should be opened by the OS (wallet deep links,
 *  mailto, tel) rather than loaded inside the WebView or in-app browser. */
export function isDeepLink(url: string): boolean {
  return (
    DEEP_LINK_SCHEME_RE.test(url) ||
    WALLET_UNIVERSAL_LINK_PREFIXES.some((prefix) => url.startsWith(prefix))
  );
}

export async function openDeepLink(url: string): Promise<void> {
  await Linking.openURL(url);
}

export function getURLHandlers(): BridgeHandlerMap {
  return {
    openExternalURL: async (msg) => {
      const url = typeof msg.url === 'string' ? msg.url : undefined;
      if (!url) return;

      try {
        if (isDeepLink(url)) {
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
