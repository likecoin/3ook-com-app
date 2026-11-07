import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';

export function isVolumeKeyPagingSupported(): boolean {
  return false;
}

export function getVolumeKeyHandlers(): BridgeHandlerMap {
  return {};
}

export function registerVolumeKeyEventListeners(_send: SendToWebView): () => void {
  return () => {};
}
