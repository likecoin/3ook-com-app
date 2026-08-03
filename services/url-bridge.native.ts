import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

const DEEP_LINK_SCHEME_RE =
  /^(mailto:|tel:|wc:|metamask:|cbwallet:|rainbow:|trust:|keplrwallet:)/;

const WALLET_UNIVERSAL_LINK_PREFIXES = [
  'https://metamask.app.link/',
  'https://go.cb-w.com/',
  'https://link.trustwallet.com/',
];

/** Returns true for URLs that should be opened by the OS rather than loaded
 *  inside the WebView. Only explicitly allowed schemes and known wallet
 *  universal links are treated as deep links. */
export function isDeepLink(url: string): boolean {
  return (
    DEEP_LINK_SCHEME_RE.test(url) ||
    WALLET_UNIVERSAL_LINK_PREFIXES.some((prefix) => url.startsWith(prefix))
  );
}

export async function openDeepLink(url: string): Promise<void> {
  await Linking.openURL(url);
}

export async function openExternalURL(url: string): Promise<void> {
  // Android routes our own verified app links back into this app (a loop),
  // so open a Custom Tab; iOS sends self-opened universal links to Safari.
  if (Platform.OS === 'android' && isOwnAppLinkURL(url)) {
    await WebBrowser.openBrowserAsync(url);
    return;
  }
  await Linking.openURL(url);
}

function isOwnAppLinkURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === '3ook.com';
  } catch {
    return false;
  }
}
