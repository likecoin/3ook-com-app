import * as Linking from 'expo-linking';
import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import { trackEvent } from '../services/analytics';
import { isBookstoreURL } from '../services/external-hosts';
import { isDeepLink, openDeepLink, openExternalURL } from '../services/url-bridge';
import { resolveDeepLinkURL } from '../services/url-storage';

// `source` dimension of the launched_with_deep_link event.
export type DeepLinkSource = 'cold_start' | 'warm' | 'push_notification';

// Long enough to swallow an OS re-delivery on foreground, short enough that a
// user tapping the same link again gets the browser.
const EXTERNAL_REPEAT_WINDOW_MS = 5000;

// Routes deep links into the WebView behind a parked-until-load gate.
// `currentURLRef` stays owned by the caller — navigation-state tracking writes
// it too — and is shared here for dedupe.
export function useDeepLinkRouting({
  navigateWebView,
  currentURLRef,
}: {
  navigateWebView: (target: string) => void;
  currentURLRef: RefObject<string>;
}) {
  // A push-notification tap can resolve a deep link before the WebView's first
  // load lands (cold start). injectJavaScript is a no-op pre-load, so park the
  // URL and flush it once the page is navigable again.
  const hasLoadedRef = useRef(false);
  const pendingDeepLinkRef = useRef<string | null>(null);
  // The OS re-delivers an unchanged `url` event on every foreground, which
  // would otherwise re-open the browser and re-report the launch each time.
  // Windowed rather than permanent, as saveLastURL does: routeToWebView can
  // dedupe forever because navigation rewrites currentURLRef, but nothing
  // clears this one, and a second deliberate tap is a real launch.
  const lastExternalRef = useRef<{ url: string; at: number } | null>(null);

  // Every external open goes through here, so they all share the dedupe.
  const openExternalOnce = useCallback((url: string, source: DeepLinkSource) => {
    const now = Date.now();
    const last = lastExternalRef.current;
    if (last?.url === url && now - last.at < EXTERNAL_REPEAT_WINDOW_MS) return;
    const attempt = { url, at: now };
    lastExternalRef.current = attempt;
    trackEvent('launched_with_deep_link', { source, disposition: 'external' });
    openExternalURL(url).catch((e) => {
      // Release the guard so a failed open is retryable before the window,
      // unless a later attempt has already claimed it. Identity, not URL: the
      // Android Custom Tab promise stays pending until the tab is dismissed.
      if (lastExternalRef.current === attempt) lastExternalRef.current = null;
      console.warn(`[${source} external link] failed to open:`, e);
    });
  }, []);

  // All in-WebView deep-link entries (warm Universal Links, push taps) share
  // the dedupe, tracking, and parked-until-load gate here.
  const routeToWebView = useCallback(
    (target: string, source: DeepLinkSource) => {
      if (target === currentURLRef.current) return;
      trackEvent('launched_with_deep_link', { source, disposition: 'webview' });
      currentURLRef.current = target;
      if (hasLoadedRef.current) {
        navigateWebView(target);
      } else {
        pendingDeepLinkRef.current = target;
      }
    },
    [navigateWebView, currentURLRef]
  );

  // Cold start can't use routeToWebView: its URL seeds the WebView's first
  // mount rather than a navigation, so this returns the target instead of
  // navigating. Keeps every launched_with_deep_link emission in one file.
  const resolveColdStartURL = useCallback(
    (rawURL: string | null) => {
      const target = resolveDeepLinkURL(rawURL);
      if (target) {
        trackEvent('launched_with_deep_link', {
          source: 'cold_start',
          disposition: 'webview',
        });
        return target;
      }
      if (rawURL && isBookstoreURL(rawURL)) {
        openExternalOnce(rawURL, 'cold_start');
      }
      return null;
    },
    [openExternalOnce]
  );

  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      const target = resolveDeepLinkURL(url);
      if (target) {
        routeToWebView(target, 'warm');
        return;
      }
      if (isBookstoreURL(url)) {
        openExternalOnce(url, 'warm');
      }
    });
    return () => sub.remove();
  }, [routeToWebView, openExternalOnce]);

  // Intercom push campaigns with a "URI on tap" deliver the destination via
  // expo-notifications, not expo-linking, so they bypass the Linking listener
  // above. The payload is campaign-authored (server-controlled), so route it
  // through the same trust tiers as in-WebView navigation: 3ook host → SPA,
  // allowlisted deep links (custom schemes + known wallet universal links) →
  // OS, other https:// → system browser. Anything else (http://, javascript:,
  // data:, non-allowlisted custom schemes) is dropped, never opened.
  const handleNotificationDeepLink = useCallback(
    (rawURL: string) => {
      const target = resolveDeepLinkURL(rawURL);
      if (target) {
        routeToWebView(target, 'push_notification');
        return;
      }
      if (isDeepLink(rawURL)) {
        trackEvent('launched_with_deep_link', {
          source: 'push_notification',
          disposition: 'os',
        });
        openDeepLink(rawURL).catch((e) =>
          console.warn('[push deep link] failed to open:', e)
        );
        return;
      }
      try {
        const { protocol } = new URL(rawURL);
        // HTTPS only: a campaign has no reason to open plaintext http, and
        // dropping it removes a downgrade/MITM vector on the external tier.
        if (protocol === 'https:') {
          openExternalOnce(rawURL, 'push_notification');
          return;
        }
      } catch {
        // Unparseable URI — fall through to the rejection path.
      }
      trackEvent('launched_with_deep_link', {
        source: 'push_notification',
        disposition: 'rejected',
      });
    },
    [routeToWebView, openExternalOnce]
  );

  // Any full document load (cold start, pull-to-refresh, reload()) starts in a
  // pre-navigable state where injectJavaScript is dropped. Re-arm the gate so
  // deep links park until the next successful load. SPA pushState navigations
  // don't fire onLoadStart, so this stays paired with the onLoad success path.
  const markLoadStarted = useCallback(() => {
    hasLoadedRef.current = false;
  }, []);

  // Open the gate and flush any deep link parked during the pre-navigable
  // window. A link parked during a failed cold start intentionally survives
  // retry remounts and flushes here on the eventual successful load.
  const markLoadCompleted = useCallback(() => {
    hasLoadedRef.current = true;
    const pending = pendingDeepLinkRef.current;
    if (pending) {
      pendingDeepLinkRef.current = null;
      navigateWebView(pending);
    }
  }, [navigateWebView]);

  // Read-only view of the gate; the ref itself stays private so callers
  // can't corrupt it.
  const isLoaded = useCallback(() => hasLoadedRef.current, []);

  return {
    resolveColdStartURL,
    handleNotificationDeepLink,
    markLoadStarted,
    markLoadCompleted,
    isLoaded,
  };
}
