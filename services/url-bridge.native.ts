import * as Linking from 'expo-linking';

const HTTP_SCHEME_RE = /^https?:\/\//i;

const WALLET_UNIVERSAL_LINK_PREFIXES = [
  'https://metamask.app.link/',
  'https://go.cb-w.com/',
  'https://link.trustwallet.com/',
];

/** Returns true for URLs that should be opened by the OS rather than loaded
 *  inside the WebView. Any non-http(s) scheme (wc:, metamask:, mailto:, etc.)
 *  is treated as a deep link, plus known wallet universal links. */
export function isDeepLink(url: string): boolean {
  return (
    !HTTP_SCHEME_RE.test(url) ||
    WALLET_UNIVERSAL_LINK_PREFIXES.some((prefix) => url.startsWith(prefix))
  );
}

export async function openDeepLink(url: string): Promise<void> {
  await Linking.openURL(url);
}
