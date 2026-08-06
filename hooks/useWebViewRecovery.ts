import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { WebViewErrorEvent } from 'react-native-webview/lib/WebViewTypes';

import { trackEvent } from '../services/analytics';

// NetInfo reports isConnected as boolean | null; treat null/unknown as online so
// the WebView is never gated offline on an indeterminate signal.
const isStateOnline = (state: NetInfoState) => state.isConnected !== false;

const IS_IOS = Platform.OS === 'ios';

// Path only — query strings on 3ook.com URLs can carry auth and session tokens.
const toPathOnly = (url?: string) => {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};

// Cold-start loads of 3ook.com sometimes fail with transient network errors
// (NSURLErrorDomain -1004 cannot-connect-to-host being the most common) before
// the radio/VPN/captive portal has fully settled. Auto-retry by remounting the
// WebView via a key bump, then fall back to a manual retry overlay.
const AUTO_RETRY_DELAYS_MS = [250, 750, 1000, 2500];
const MAX_AUTO_RETRIES = AUTO_RETRY_DELAYS_MS.length;

// WebView load-failure recovery: auto-retry with backoff while online, an
// offline overlay plus reconnect-triggered remount while offline, and a manual
// Retry fallback. `onRemount` runs before each key bump so the caller can
// reset its own per-load state (e.g. the deep-link parked-until-load gate).
export function useWebViewRecovery({ onRemount }: { onRemount: () => void }) {
  const [webViewKey, setWebViewKey] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isRetryInProgress, setIsRetryInProgress] = useState(false);
  // Connectivity drives two things: the Android cacheMode (serve the cached PWA
  // shell when offline so the service worker can boot) and auto-recovery (reload
  // the moment the connection returns instead of stranding the user on a manual
  // Retry button). Mirror to a ref so the error/recovery callbacks read the
  // current value without re-subscribing.
  const [isOnline, setIsOnline] = useState(true);
  const isOnlineRef = useRef(true);
  const retryCountRef = useRef(0);
  const hadLoadFailureRef = useRef(false);
  // onLoad fires on every full document load — retry remounts, the
  // content-process-terminated reload, pull-to-refresh. Emit content-loaded once
  // per launch so the install→content funnel counts reach, not reloads.
  const contentLoadedRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // iOS keeps the committed document when a navigation fails before committing,
  // so a failure there costs the user nothing unless we cover it up or remount
  // over it. Android loses the page to Chromium's error screen either way.
  const hasDocumentRef = useRef(false);

  // Seed connectivity before the WebView's first mount: the initial render
  // assumes online (LOAD_DEFAULT), so a cold offline launch would fail on the
  // network before NetInfo reports back. Awaiting this before mounting means
  // the first navigation already uses the offline cache mode on Android.
  // Never rejects; defaults to online if NetInfo is unavailable.
  const seedConnectivity = useCallback(async () => {
    const online = await Promise.resolve()
      .then(() => NetInfo.fetch())
      .then(isStateOnline)
      .catch(() => true);
    isOnlineRef.current = online;
    setIsOnline(online);
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  // Call whenever the rendered page goes away (iOS discarding the WebView
  // content process, a remount) so the error surface takes over again.
  const notifyDocumentLost = useCallback(() => {
    hasDocumentRef.current = false;
  }, []);

  // Read at render time by renderError, which only runs after a failure — so a
  // ref is enough and no re-render is needed to keep it truthful.
  const shouldPreserveDocument = useCallback(() => IS_IOS && hasDocumentRef.current, []);

  const remountWebView = useCallback(() => {
    clearRetryTimer();
    setLoadFailed(false);
    notifyDocumentLost();
    onRemount();
    setWebViewKey((k) => k + 1);
  }, [clearRetryTimer, notifyDocumentLost, onRemount]);

  const handleManualRetry = useCallback(() => {
    trackEvent('webview_load_retry', { trigger: 'manual' });
    retryCountRef.current = 0;
    setIsRetryInProgress(true);
    remountWebView();
  }, [remountWebView]);

  // Success-only — onLoadEnd also fires on error (after onError), which would
  // clobber the retry timer we just set. Wire this to onLoad, not onLoadEnd.
  const notifyLoadSucceeded = useCallback(() => {
    // Ahead of the resets below so both properties still carry real values.
    // had_failure is not implied by retry_count: the offline and reconnect
    // paths zero the counter before recovery lands here.
    if (!contentLoadedRef.current) {
      contentLoadedRef.current = true;
      trackEvent('webview_content_loaded', {
        retry_count: retryCountRef.current,
        had_failure: hadLoadFailureRef.current,
      });
    }
    if (hadLoadFailureRef.current) {
      trackEvent('webview_load_recovered', { retry_count: retryCountRef.current });
      hadLoadFailureRef.current = false;
    }
    retryCountRef.current = 0;
    hasDocumentRef.current = true;
    clearRetryTimer();
    setLoadFailed(false);
    setIsRetryInProgress(false);
  }, [clearRetryTimer]);

  const handleWebViewError = useCallback(
    (e: WebViewErrorEvent) => {
      const { code, domain, description } = e.nativeEvent;
      // -999 (NSURLErrorCancelled) fires when navigation is preempted, e.g. by
      // onShouldStartLoadWithRequest returning false to hand off to the system
      // browser. Not a real load failure — ignore.
      if (code === -999) return;
      const attempt = retryCountRef.current;
      const offline = !isOnlineRef.current;
      const hadDocument = hasDocumentRef.current;
      trackEvent('webview_load_failed', {
        code,
        domain: domain ?? null,
        description: description ?? null,
        retry_count: attempt,
        offline,
        had_document: hadDocument,
        url_path: toPathOnly(e.nativeEvent.url),
      });
      // Leave a live page alone: walling it off — or remounting, which
      // re-navigates away — costs more than letting the failure be a no-op. The
      // web app owns the messaging from here, since its JS context survives too.
      if (hadDocument && IS_IOS) return;
      hadLoadFailureRef.current = true;
      // Offline: remounting to the network just fails again, and on Android the
      // cached PWA shell was already attempted via cacheMode (LOAD_CACHE_ELSE_
      // NETWORK) on this same load. So skip the auto-retry burst, surface the
      // offline overlay immediately, and let the NetInfo listener auto-recover
      // when the connection returns.
      if (offline) {
        clearRetryTimer();
        retryCountRef.current = 0;
        setIsRetryInProgress(false);
        setLoadFailed(true);
        return;
      }
      if (attempt < MAX_AUTO_RETRIES) {
        const delay = AUTO_RETRY_DELAYS_MS[attempt];
        retryCountRef.current = attempt + 1;
        setIsRetryInProgress(true);
        clearRetryTimer();
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          trackEvent('webview_load_retry', { trigger: 'auto', attempt: attempt + 1 });
          remountWebView();
        }, delay);
      } else {
        clearRetryTimer();
        setIsRetryInProgress(false);
        setLoadFailed(true);
      }
    },
    [clearRetryTimer, remountWebView]
  );

  useEffect(() => {
    return () => {
      clearRetryTimer();
    };
  }, [clearRetryTimer]);

  // Auto-recover when connectivity returns. A cold offline launch lands on the
  // offline overlay (or a cached shell); the moment the radio reconnects, remount
  // for a fresh online load instead of stranding the user on the manual Retry
  // button. Also keeps isOnline/cacheMode in sync for the offline error path.
  useEffect(() => {
    // Guard the subscription: if the RNCNetInfo native module is ever missing
    // (e.g. a JS-only update shipped onto a binary built before this dependency),
    // addEventListener throws — swallow it so the rest of the screen still mounts
    // instead of crashing; the app just loses auto-recovery, not core function.
    try {
      const unsub = NetInfo.addEventListener((state) => {
        const online = isStateOnline(state);
        // NetInfo fires on any network detail change (signal, SSID, cellular
        // subtype); only act on an actual connected/disconnected flip.
        if (online === isOnlineRef.current) return;
        isOnlineRef.current = online;
        setIsOnline(online);
        if (online && hadLoadFailureRef.current) {
          trackEvent('webview_load_retry', { trigger: 'reconnect' });
          retryCountRef.current = 0;
          setIsRetryInProgress(true);
          remountWebView();
        }
      });
      return unsub;
    } catch {
      // Native module absent — skip auto-recovery.
    }
  }, [remountWebView]);

  return {
    isOnline,
    loadFailed,
    isRetryInProgress,
    webViewKey,
    seedConnectivity,
    shouldPreserveDocument,
    notifyLoadSucceeded,
    notifyDocumentLost,
    handleWebViewError,
    handleManualRetry,
  };
}
