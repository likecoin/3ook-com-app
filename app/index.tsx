import CookieManager from '@preeternal/react-native-cookie-manager';
import * as Application from 'expo-application';
import * as Linking from 'expo-linking';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewHttpErrorEvent,
  WebViewNavigation,
  WebViewRenderProcessGoneEvent,
} from 'react-native-webview/lib/WebViewTypes';

import packageJson from '../package.json';
import { LoadErrorOverlay } from '../components/LoadErrorOverlay';
import { MetaMaskLoginButton } from '../components/MetaMaskLoginButton';
import { useDeepLinkRouting } from '../hooks/useDeepLinkRouting';
import { useWebViewRecovery } from '../hooks/useWebViewRecovery';
import { trackEvent } from '../services/analytics';
import { isAppBoundHost } from '../services/app-bound-domains';
import { isBookstoreURL, isExternalBrowserHost } from '../services/external-hosts';
import {
  getAudioHandlers,
  registerEventListeners,
  setupPlayer,
} from '../services/audio-bridge';
import { initAudioCache } from '../services/audio-cache';
import { clearHandlers, dispatch, registerHandlers } from '../services/bridge-dispatcher';
import { getDownloadHandlers } from '../services/download-bridge';
import { getIdentityHandlers } from '../services/identity-bridge';
import { captureInstallAttribution } from '../services/install-attribution';
import type { InstallAttribution } from '../services/install-attribution';
import {
  configureIAP,
  getIAPHandlers,
  isIAPAvailable,
  wrapIdentityForIAP,
} from '../services/iap-bridge';
import {
  getIntercomHandlers,
  isIntercomAvailable,
  isIntercomPushSupported,
  registerIntercomEventListeners,
  resyncPushStatusToWeb,
  wrapIdentityHandlers,
} from '../services/intercom-bridge';
import {
  getStoreReviewHandlers,
  startStoreReviewWatcher,
} from '../services/store-review';
import { getWebViewCacheHandlers } from '../services/webview-cache-bridge';
import {
  clearWebViewCache,
  isWebViewCacheClearSupported,
} from '../modules/webview-cache';
import {
  isDeepLink,
  isWalletConnectCallbackURL,
  openDeepLink,
  openExternalURL,
} from '../services/url-bridge';
import { getInitialURL, resolveDeepLinkURL, saveLastURL } from '../services/url-storage';

// Appended to (not replacing) the system WebView UA via applicationNameForUserAgent,
// so the real Chromium version stays visible to the web app, server, and analytics.
// The web app parses this token — keep its shape in sync with APP_USER_AGENT_REGEX.
const APP_UA_SUFFIX = (() => {
  const appVersion = Application.nativeApplicationVersion ?? packageJson.version;
  const buildNumber = Application.nativeBuildVersion;
  const buildToken = buildNumber ? ` Build/${buildNumber}` : '';
  const osName = Platform.OS === 'ios' ? 'iOS' : 'Android';
  return `3ook-com-app/${appVersion} (${osName} ${Platform.Version})${buildToken}`;
})();

// Capability advertisement so web can detect what this build supports without
// pinning to a build number. Add a string here when introducing a new
// bridge that web should be able to feature-detect.
const NATIVE_BRIDGE_FEATURES: readonly string[] = [
  ...(isIntercomAvailable() ? ['intercom'] : []),
  // Push is currently routed through the Intercom handler (`requestPushPermission`,
  // `pushPermissionChanged`); advertise only when both are usable.
  ...(isIntercomPushSupported() ? ['intercomPush'] : []),
  // RevenueCat in-app purchases; only when a platform API key is configured.
  // `iapCivic` marks builds whose purchase bridge understands the Civic tier.
  ...(isIAPAvailable() ? ['iap', 'iapCivic'] : []),
  // Native App Store / Play rating prompt. Whether it actually appears is up to
  // the store (engagement gate, per-version and yearly quotas), so web should
  // treat requestStoreReview as a hint, never as a guaranteed dialog.
  'storeReview',
  // Native WKWebView cache clear; the web chunk-error plugin's last escalation
  // rung. See modules/webview-cache.
  ...(isWebViewCacheClearSupported() ? ['clearWebViewCache'] : []),
  // Drops app-managed content caches (currently TTS audio); wired to the web's
  // clear-caches flow. Deliberately not gated by the cache kill-switch flag:
  // clearing must work even when the cache is flagged off.
  'clearNativeCaches',
];
const NATIVE_BRIDGE_BOOTSTRAP = `(function(){try{window.__nativeBridge=window.__nativeBridge||{};window.__nativeBridge.features=${JSON.stringify(NATIVE_BRIDGE_FEATURES)};}catch(e){}})();true;`;
const WEBVIEW_DEBUG_BOOTSTRAP = __DEV__
  ? `(function(){
      function sanitizeUrl(value){
        try {
          var u = new URL(String(value), window.location.href);
          return u.origin + u.pathname;
        } catch (e) {
          return undefined;
        }
      }
      function stringify(value){
        try {
          if (value && value.message) return String(value.message);
          return String(value);
        } catch (e) {
          return '[unprintable]';
        }
      }
      function post(payload){
        try {
          if (!window.ReactNativeWebView) return;
          window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({
            type: '__nativeDebugLog',
            page: sanitizeUrl(window.location.href)
          }, payload)));
        } catch (e) {}
      }
      window.addEventListener('error', function(event){
        post({
          level: 'error',
          source: 'window.error',
          message: stringify(event.message || event.error).slice(0, 500),
          filename: sanitizeUrl(event.filename),
          line: event.lineno || null,
          column: event.colno || null
        });
      });
      window.addEventListener('unhandledrejection', function(event){
        post({
          level: 'error',
          source: 'unhandledrejection',
          message: stringify(event.reason).slice(0, 500)
        });
      });
      if (typeof window.fetch === 'function') {
        var originalFetch = window.fetch;
        window.fetch = function(input, init){
          var requestUrl = typeof input === 'string' ? input : input && input.url;
          return originalFetch.apply(this, arguments).then(function(response){
            if (response && response.status >= 400) {
              post({
                level: 'error',
                source: 'fetch',
                message: 'HTTP ' + response.status,
                url: sanitizeUrl(response.url || requestUrl)
              });
            }
            return response;
          }).catch(function(error){
            post({
              level: 'error',
              source: 'fetch',
              message: stringify(error).slice(0, 500),
              url: sanitizeUrl(requestUrl)
            });
            throw error;
          });
        };
      }
      if (typeof window.XMLHttpRequest === 'function') {
        var OriginalXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function(){
          var xhr = new OriginalXHR();
          var requestUrl;
          var originalOpen = xhr.open;
          xhr.open = function(method, url){
            requestUrl = url;
            return originalOpen.apply(xhr, arguments);
          };
          xhr.addEventListener('loadend', function(){
            if (xhr.status >= 400) {
              post({
                level: 'error',
                source: 'xhr',
                message: 'HTTP ' + xhr.status,
                url: sanitizeUrl(xhr.responseURL || requestUrl)
              });
            }
          });
          xhr.addEventListener('error', function(){
            post({
              level: 'error',
              source: 'xhr',
              message: 'Network error',
              url: sanitizeUrl(requestUrl)
            });
          });
          return xhr;
        };
      }
      var originalError = console.error;
      console.error = function(){
        post({
          level: 'error',
          source: 'console.error',
          message: Array.prototype.slice.call(arguments).map(stringify).join(' ').slice(0, 500)
        });
        return originalError.apply(console, arguments);
      };
    })();true;`
  : 'true;';

function sanitizeURLForLog(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

// 3ook.com renders the login UI as an in-page modal rather than a
// dedicated route — URL-based detection doesn't work. Instead we ask
// "is the user logged in?" via the presence of the `nuxt-session`
// cookie on 3ook.com and show the MetaMask button whenever they're not.
function isOn3ookHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.hostname === '3ook.com' || u.hostname.endsWith('.3ook.com');
  } catch {
    return false;
  }
}

async function isLoggedInTo3ook(): Promise<boolean> {
  try {
    const cookies = await CookieManager.get('https://3ook.com');
    // `nuxt-session` is the encrypted Nuxt server session — it's the only
    // cookie 3ook.com's frontend actually trusts for auth state.
    const session = cookies?.['nuxt-session']?.value;
    return typeof session === 'string' && session.length > 0;
  } catch {
    return false;
  }
}

export default function App() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const canGoBackRef = useRef(false);
  const currentURLRef = useRef<string>('');
  const [mountURL, setMountURL] = useState<string | null>(null);
  const [isLoggedOut, setIsLoggedOut] = useState(true);
  const [isOn3ook, setIsOn3ook] = useState(false);

  const refreshMetaMaskVisibility = useCallback((rawUrl: string | null | undefined) => {
    if (!rawUrl) return;
    const on3ook = isOn3ookHost(rawUrl);
    setIsOn3ook(on3ook);
    if (!on3ook) return;
    isLoggedInTo3ook().then((loggedIn) => {
      setIsLoggedOut(!loggedIn);
      if (__DEV__) {
        console.warn('[wallet-auth] button login check', {
          url: sanitizeURLForLog(rawUrl),
          loggedIn,
        });
      }
    });
  }, []);
  // Android install-referrer attribution, persisted natively and re-asserted on
  // the window for the web's getAnalyticsParameters fallback to read.
  const installAttributionRef = useRef<InstallAttribution | null>(null);

  const sendToWebView = useCallback((data: object) => {
    const json = JSON.stringify(data);
    webViewRef.current?.injectJavaScript(
      `window.dispatchEvent(new CustomEvent('nativeAudioEvent',{detail:${json}}));` +
        `window.dispatchEvent(new CustomEvent('nativeBridgeEvent',{detail:${json}}));true;`
    );
  }, []);

  const navigateWebView = useCallback((target: string) => {
    webViewRef.current?.injectJavaScript(
      `window.location.href = ${JSON.stringify(target)};true;`
    );
  }, []);

  const {
    handleNotificationDeepLink,
    markLoadStarted,
    markLoadCompleted,
    isLoaded,
  } = useDeepLinkRouting({ navigateWebView, currentURLRef });

  // A remount re-navigates to `source`, so re-snapshot the live URL or a retry
  // resumes where the app launched instead of where the user was. Vetted the
  // same way as a cold start: currentURLRef also holds unnormalized URLs.
  const handleRemount = useCallback(() => {
    // Resets only the load gate: a deep link parked during a failed cold start
    // survives the retry remount and flushes on the eventual successful load.
    markLoadStarted();
    setMountURL((prev) => resolveDeepLinkURL(currentURLRef.current) ?? prev);
  }, [markLoadStarted]);

  const {
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
    remountWebView,
  } = useWebViewRecovery({ onRemount: handleRemount });

  useEffect(() => {
    // Kick off connectivity resolution in parallel with URL resolution — it's
    // independent of the URL, and we only need it right before the first mount,
    // so overlapping it with the Linking/storage awaits keeps it off the
    // cold-start critical path.
    const connectivityReady = seedConnectivity();
    (async () => {
      const deepLink = await Linking.getInitialURL();
      // WalletConnect returns via https://3ook.com?wc_ev=…; AppKit consumes
      // that Linking URL. Do not treat it as a bookstore page.
      const resolved = isWalletConnectCallbackURL(deepLink ?? '')
        ? null
        : resolveDeepLinkURL(deepLink);
      if (resolved) {
        trackEvent('launched_with_deep_link', {
          source: 'cold_start',
          disposition: 'webview',
        });
      } else if (deepLink && isBookstoreURL(deepLink)) {
        trackEvent('launched_with_deep_link', {
          source: 'cold_start',
          disposition: 'external',
        });
        openExternalURL(deepLink).catch((e) =>
          console.warn('[cold start external link] failed to open:', e)
        );
      }
      const url = resolved ?? (await getInitialURL());
      currentURLRef.current = url;
      // Await the connectivity seed before the WebView's first mount so a cold
      // offline launch already uses the offline cache mode on Android.
      await connectivityReady;
      setMountURL(url);
      refreshMetaMaskVisibility(url);
    })();
  }, [seedConnectivity, refreshMetaMaskVisibility]);

  // Each WebView load lands in a fresh JS context, so re-assert install
  // attribution on every load; the web reads it lazily at checkout time.
  const injectInstallAttribution = useCallback(() => {
    const attr = installAttributionRef.current;
    if (!attr) return;
    webViewRef.current?.injectJavaScript(
      `window.__nativeBridge=window.__nativeBridge||{};` +
        `window.__nativeBridge.installAttribution=${JSON.stringify(attr)};true;`
    );
  }, []);

  // Last-resort recovery for the stale-chunk loop: iOS wipes the SW registration
  // via the native module (which RNCWebView's clearCache can't); Android clears
  // the WebView HTTP cache. markLoadStarted gates injection across the reload.
  const clearWebViewCacheAndReload = useCallback(async () => {
    markLoadStarted();
    try {
      if (Platform.OS === 'ios') {
        await clearWebViewCache();
      } else {
        // clearCache isn't on react-native-webview's exported ref type but is
        // implemented on both platforms' imperative handles.
        (
          webViewRef.current as unknown as {
            clearCache?: (includeDiskFiles: boolean) => void;
          } | null
        )?.clearCache?.(true);
      }
    } catch (e) {
      console.warn('[webview-cache] clear failed', e);
    }
    webViewRef.current?.reload();
  }, [markLoadStarted]);

  useEffect(() => {
    configureIAP();
    captureInstallAttribution().then((attr) => {
      if (!attr || (!Object.keys(attr.attribution).length && !attr.affiliateFrom)) return;
      installAttributionRef.current = attr;
      if (isLoaded()) injectInstallAttribution();
    });
    registerHandlers(getAudioHandlers());
    registerHandlers(getDownloadHandlers());
    registerHandlers(getIntercomHandlers(sendToWebView));
    registerHandlers(getIAPHandlers(sendToWebView));
    registerHandlers(getStoreReviewHandlers());
    registerHandlers(getWebViewCacheHandlers(clearWebViewCacheAndReload));
    // identifyUser/resetUser fan out to analytics (base), RevenueCat logIn/Out
    // (IAP wrap), then Intercom (outer wrap) — one identity event, three sinks.
    const identityHandlers = wrapIdentityHandlers(
      wrapIdentityForIAP(getIdentityHandlers()),
      sendToWebView
    );
    registerHandlers({
      ...identityHandlers,
      identifyUser: async (msg) => {
        await identityHandlers.identifyUser?.(msg);
        if (typeof msg.userId === 'string' && msg.userId) {
          setIsLoggedOut(false);
        }
      },
      resetUser: async (msg) => {
        await identityHandlers.resetUser?.(msg);
        setIsLoggedOut(true);
      },
    });

    setupPlayer();
    initAudioCache();
    const unsubscribeAudio = registerEventListeners(sendToWebView);
    const unsubscribeIntercom = registerIntercomEventListeners(
      sendToWebView,
      handleNotificationDeepLink
    );
    const unsubscribeStoreReview = startStoreReviewWatcher();
    return () => {
      unsubscribeAudio();
      unsubscribeIntercom();
      unsubscribeStoreReview();
      clearHandlers();
    };
  }, [
    sendToWebView,
    handleNotificationDeepLink,
    injectInstallAttribution,
    isLoaded,
    clearWebViewCacheAndReload,
  ]);

  // Reload WebView when iOS kills its content process in the background.
  const handleContentProcessDidTerminate = useCallback(() => {
    trackEvent('webview_content_terminated');
    // reload() also triggers onLoadStart → markLoadStarted, but that fires
    // async: a tap landing between this call and onLoadStart would inject into
    // the now-dead JS context. Gate synchronously here to close that window.
    markLoadStarted();
    notifyDocumentLost();
    webViewRef.current?.reload();
  }, [markLoadStarted, notifyDocumentLost]);

  // Success-only load handler (see notifyLoadSucceeded for why not onLoadEnd).
  // Inject attribution before markLoadCompleted flushes any parked navigation.
  const handleLoad = useCallback(() => {
    notifyLoadSucceeded();
    injectInstallAttribution();
    markLoadCompleted();
    refreshMetaMaskVisibility(currentURLRef.current);
  }, [
    notifyLoadSucceeded,
    injectInstallAttribution,
    markLoadCompleted,
    refreshMetaMaskVisibility,
  ]);

  // Each WebView load lands in a fresh JS context with no memory of prior
  // dispatches; re-emit native state that web listeners want at boot.
  const handleLoadEnd = useCallback(() => {
    if (isIntercomPushSupported()) {
      resyncPushStatusToWeb(sendToWebView);
    }
  }, [sendToWebView]);

  // Intercept wallet deep links (wc:, metamask:, etc.) and route non-app-bound
  // top-frame navigations to the system browser — WebKit's app-bound enforcement
  // would otherwise silently block them.
  const handleNavigationRequest = useCallback(
    (request: ShouldStartLoadRequest) => {
      if (isWalletConnectCallbackURL(request.url)) {
        return false;
      }
      if (isDeepLink(request.url)) {
        // Don't capture full URL — wallet links can carry session tokens or
        // user data. Scheme/host is enough to attribute the route.
        let scheme = 'unknown';
        let host: string | null = null;
        try {
          const parsed = new URL(request.url);
          scheme = parsed.protocol.replace(':', '');
          host = parsed.hostname || null;
        } catch {
          // Custom schemes (wc:, metamask:) may not parse — fall back to prefix.
          scheme = request.url.split(':')[0] || 'unknown';
        }
        trackEvent('deep_link_opened', { scheme, host });
        openDeepLink(request.url).catch((e) =>
          console.warn('[deep link] failed to open:', request.url, e)
        );
        return false;
      }
      // Leave iframes to WebKit; non-app-bound iframe loads (e.g. Stripe's
      // metrics iframe) get silently blocked there, which is intended.
      if (request.isTopFrame === false) return true;
      try {
        const parsed = new URL(request.url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return true;
        // Browser-only destinations would be kept in-app by isAppBoundHost;
        // let them open externally.
        if (
          isAppBoundHost(parsed.hostname) &&
          !isExternalBrowserHost(parsed.hostname) &&
          !isBookstoreURL(request.url)
        )
          return true;
        trackEvent('external_url_opened', { host: parsed.hostname });
        openExternalURL(request.url).catch((e) =>
          console.warn('[external link] failed to open:', request.url, e)
        );
        return false;
      } catch {
        return true;
      }
    },
    []
  );

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleNavigationStateChange = useCallback(
    (navState: WebViewNavigation) => {
      canGoBackRef.current = navState.canGoBack;
      if (!navState.url) return;
      const resolvedURL = resolveDeepLinkURL(navState.url) ?? navState.url;
      currentURLRef.current = resolvedURL;
      if (__DEV__) {
        console.warn('[WebView navigation]', {
          url: sanitizeURLForLog(resolvedURL),
          loading: navState.loading,
          canGoBack: navState.canGoBack,
        });
      }
      refreshMetaMaskVisibility(resolvedURL);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveLastURL(resolvedURL), 1500);
    },
    [refreshMetaMaskVisibility]
  );

  useEffect(() => {
    if (!__DEV__) return;
    console.warn('[wallet-auth] button visibility', {
      isOn3ook,
      isLoggedOut,
      loadFailed,
      isRetryInProgress,
      visible: isOn3ook && isLoggedOut && !loadFailed && !isRetryInProgress,
    });
  }, [isOn3ook, isLoggedOut, loadFailed, isRetryInProgress]);

  // After MetaMask login we have to force a fresh server-side render so
  // Nuxt SSR picks up the newly-installed `nuxt-session` cookie. A bare
  // `webView.reload()` may serve the cached HTML (Nuxt's payload includes
  // the SSR-rendered auth state), so we mutate window.location to a URL
  // with a cache-bust query param, guaranteeing a fresh GET.
  const handleMetaMaskAuthenticated = useCallback(() => {
    setIsLoggedOut(false);
    webViewRef.current?.injectJavaScript(
      `(function(){
        try {
          var u = new URL(window.location.href);
          u.searchParams.set('_t', String(Date.now()));
          window.location.href = u.toString();
        } catch (e) {
          window.location.reload();
        }
      })();
      true;`
    );
  }, []);
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBackRef.current) {
        webViewRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      const raw = event.nativeEvent.data;
      try {
        const msg = JSON.parse(raw) as unknown;
        if (
          msg &&
          typeof msg === 'object' &&
          'type' in msg &&
          (msg as { type?: unknown }).type === '__nativeDebugLog'
        ) {
          const debug = msg as Record<string, unknown>;
          console.warn('[WebView debug]', {
            level: typeof debug.level === 'string' ? debug.level : 'unknown',
            source: typeof debug.source === 'string' ? debug.source : 'unknown',
            message: typeof debug.message === 'string' ? debug.message : '',
            page: typeof debug.page === 'string' ? debug.page : undefined,
            filename: typeof debug.filename === 'string' ? debug.filename : undefined,
            line: typeof debug.line === 'number' ? debug.line : undefined,
            column: typeof debug.column === 'number' ? debug.column : undefined,
          });
          return;
        }
      } catch {
        // Let the bridge dispatcher produce the existing malformed JSON warning.
      }
      try {
        await dispatch(raw);
      } catch (e) {
        console.warn('[onMessage]', e);
      }
    },
    []
  );

  const handleHttpError = useCallback((e: WebViewHttpErrorEvent) => {
    const { statusCode, description, url } = e.nativeEvent;
    console.warn('[WebView HTTP error]', {
      statusCode,
      description,
      url: sanitizeURLForLog(url),
    });
  }, []);

  const handleRenderProcessGone = useCallback(
    (e: WebViewRenderProcessGoneEvent) => {
      console.warn('[WebView render process gone]', {
        didCrash: e.nativeEvent.didCrash,
        url: sanitizeURLForLog(currentURLRef.current),
      });
      trackEvent('webview_render_process_gone', {
        did_crash: e.nativeEvent.didCrash,
      });
      remountWebView();
    },
    [remountWebView]
  );

  return (
    <>
      <View style={[styles.topSpacer, { height: insets.top }]} />
      <View style={styles.container}>
        {mountURL && (
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={{ uri: mountURL }}
            originWhitelist={['*']}
            style={styles.webview}
            applicationNameForUserAgent={APP_UA_SUFFIX}
            sharedCookiesEnabled={true}
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback={true}
            pullToRefreshEnabled={true}
            allowsBackForwardNavigationGestures={true}
            limitsNavigationsToAppBoundDomains={Platform.OS === 'ios'}
            // Android only: when offline, serve the last-cached shell (even if
            // expired) so the PWA's service worker can boot and render its
            // offline content. Stays LOAD_DEFAULT while online so fresh loads
            // are never served stale. iOS ignores this and relies on its SW.
            cacheMode={!isOnline ? 'LOAD_CACHE_ELSE_NETWORK' : 'LOAD_DEFAULT'}
            // Suppress react-native-webview's built-in error page (the raw
            // "Error loading page / net::ERR_INTERNET_DISCONNECTED" Chromium
            // screen on Android, blank on iOS). LoadErrorOverlay is the single
            // error surface; render a matching-color blank so there's no flash,
            // except over a preserved page, which the fill would itself hide.
            renderError={() => (
              <View style={shouldPreserveDocument() ? undefined : styles.errorFallback} />
            )}
            webviewDebuggingEnabled={__DEV__}
            injectedJavaScriptBeforeContentLoaded={
              NATIVE_BRIDGE_BOOTSTRAP + WEBVIEW_DEBUG_BOOTSTRAP
            }
            onShouldStartLoadWithRequest={handleNavigationRequest}
            onNavigationStateChange={handleNavigationStateChange}
            onMessage={handleMessage}
            onLoadStart={markLoadStarted}
            onLoad={handleLoad}
            onLoadEnd={handleLoadEnd}
            onContentProcessDidTerminate={handleContentProcessDidTerminate}
            onRenderProcessGone={handleRenderProcessGone}
            onError={handleWebViewError}
            onHttpError={handleHttpError}
          />
        )}
        <MetaMaskLoginButton
          visible={isOn3ook && isLoggedOut && !loadFailed && !isRetryInProgress}
          onAuthenticated={handleMetaMaskAuthenticated}
        />
        <LoadErrorOverlay
          isOnline={isOnline}
          loadFailed={loadFailed}
          isRetryInProgress={isRetryInProgress}
          onRetry={handleManualRetry}
        />
      </View>
      {/* Android WebView returns CSS env(safe-area-inset-bottom) as 0 */}
      {Platform.OS === 'android' && (
        <View style={[styles.bottomSpacer, { height: insets.bottom }]} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  topSpacer: {
    backgroundColor: '#131313',
  },
  bottomSpacer: {
    backgroundColor: '#f9f9f9',
  },
  container: {
    flex: 1,
    backgroundColor: '#f9f9f9',
  },
  webview: {
    flex: 1,
  },
  // Absolute, not flex: renderError's output is a sibling of the WebView, so a
  // flex child would split the screen with the page instead of covering it.
  errorFallback: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#f9f9f9',
  },
});
