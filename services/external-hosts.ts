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
