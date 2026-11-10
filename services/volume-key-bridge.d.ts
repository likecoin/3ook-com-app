import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';

export function isVolumeKeyPagingSupported(): boolean;

export function getVolumeKeyHandlers(): BridgeHandlerMap;

export function registerVolumeKeyEventListeners(send: SendToWebView): () => void;
