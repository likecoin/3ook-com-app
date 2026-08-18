import type { BridgeHandlerMap } from './bridge-dispatcher';

export function getWebViewCacheHandlers(
  _clearAndReload: () => void | Promise<void>
): BridgeHandlerMap {
  return {};
}
