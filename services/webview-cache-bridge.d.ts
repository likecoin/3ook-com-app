import type { BridgeHandlerMap } from './bridge-dispatcher';

export function getWebViewCacheHandlers(
  clearAndReload: () => void | Promise<void>
): BridgeHandlerMap;
