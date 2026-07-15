import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

interface WebViewCacheModule {
  clearWebViewCache(): Promise<void>;
}

// iOS-only native module. Android has no equivalent here: its WebView bypasses
// the service worker for navigation, so clearing the HTTP cache via the WebView
// ref's clearCache command is enough (handled in app/index.tsx).
const NativeModule =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<WebViewCacheModule>('WebViewCache')
    : null;

/**
 * Whether a native SW/HTTP cache clear is available for this platform. iOS needs
 * the native module built in; Android relies on the WebView ref (always usable).
 * Web is unsupported.
 */
export function isWebViewCacheClearSupported(): boolean {
  if (Platform.OS === 'ios') return !!NativeModule;
  return Platform.OS === 'android';
}

/**
 * Clears the stale service-worker registration and HTTP/disk caches that keep
 * re-serving a deleted-chunk shell on iOS WebKit. Preserves cookies and
 * LocalStorage. Resolves to a no-op where the native module is unavailable.
 */
export function clearWebViewCache(): Promise<void> {
  return NativeModule?.clearWebViewCache() ?? Promise.resolve();
}
