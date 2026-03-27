import type { BridgeHandlerMap } from './bridge-dispatcher';

export function isDeepLink(url: string): boolean;
export function openDeepLink(url: string): Promise<void>;
export function getURLHandlers(): BridgeHandlerMap;
