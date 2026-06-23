// 3ook.com subdomains that must open in the system browser, not the WebView.
// The Intercom help center (docs.3ook.com) has no in-app back affordance, so
// loading it traps the user — and as a 3ook subdomain it would be persisted and
// replayed on relaunch, surviving a kill. Routing it out fixes both.
const EXTERNAL_BROWSER_HOSTS = Object.freeze(['docs.3ook.com']);

export function isExternalBrowserHost(host: string): boolean {
  const lowerHost = host.toLowerCase();
  return EXTERNAL_BROWSER_HOSTS.includes(lowerHost);
}
