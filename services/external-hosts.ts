// 3ook.com subdomains that must open in the system browser, not the WebView.
// Keeping them in-app would trap the user (no back affordance) and persist
// them across relaunches; these sites aren't part of the wrapped app.
const EXTERNAL_BROWSER_HOSTS = Object.freeze([
  'docs.3ook.com',
  'publish.3ook.com',
]);

export function isExternalBrowserHost(host: string): boolean {
  const lowerHost = host.toLowerCase();
  return EXTERNAL_BROWSER_HOSTS.includes(lowerHost);
}

const BOOKSTORE_PATH_REGEX = /^\/(?:[a-z]{2}(?:-[A-Za-z]{2,4})?\/)?store(?:\/|$)/i;

export function isBookstorePath(pathname: string): boolean {
  return BOOKSTORE_PATH_REGEX.test(pathname);
}

export function isBookstoreURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== '3ook.com' && !host.endsWith('.3ook.com')) return false;
    return isBookstorePath(parsed.pathname);
  } catch {
    return false;
  }
}
