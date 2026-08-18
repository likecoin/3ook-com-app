import type { BridgeHandlerMap } from './bridge-dispatcher';

// Routes the clearWebViewCache message to the shell's clear-and-reload callback,
// which lives in app/index.tsx where the WebView ref is in scope.
export function getWebViewCacheHandlers(
  clearAndReload: () => void | Promise<void>
): BridgeHandlerMap {
  return {
    clearWebViewCache: clearAndReload,
  };
}
