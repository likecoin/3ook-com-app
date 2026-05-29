// CommonJS so both runtime TS code and the Expo config plugin (plain Node)
// can consume a single source of truth for the WKAppBoundDomains list.
const APP_BOUND_DOMAINS = Object.freeze([
  '3ook.com',
  'magic.link',
  'walletconnect.com',
  'youtube.com',
]);

function isAppBoundHost(host) {
  const lowerHost = host.toLowerCase();
  return APP_BOUND_DOMAINS.some(
    (domain) => lowerHost === domain || lowerHost.endsWith(`.${domain}`)
  );
}

// Narrower than isAppBoundHost: only 3ook.com and its subdomains, never the
// third-party app-bound domains. Use this where the 3ook origin specifically
// matters (e.g. service-worker scope), not general app-bound navigation.
function is3ookHost(host) {
  const lowerHost = host.toLowerCase();
  return lowerHost === '3ook.com' || lowerHost.endsWith('.3ook.com');
}

module.exports = { APP_BOUND_DOMAINS, isAppBoundHost, is3ookHost };
