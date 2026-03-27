import type { BridgeHandlerMap } from './bridge-dispatcher';

export function isDeepLink(_url: string): boolean {
  return false;
}

export async function openDeepLink(_url: string): Promise<void> {}

export function getURLHandlers(): BridgeHandlerMap {
  return {};
}
