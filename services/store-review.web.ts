import type { BridgeHandlerMap } from './bridge-dispatcher';
import type { StoreReviewReason } from './store-review';

// Web has no App Store / Play rating prompt — every export is a no-op so the
// shared bridges can import this without dragging expo-store-review into the
// web bundle. Mirrors iap-bridge.web.ts.
export function recordListening(_ms: number): void {}

export function setAudioActive(_isActive: boolean): void {}

export function armStoreReview(_reason: StoreReviewReason): void {}

export function startStoreReviewWatcher(): () => void {
  return () => {};
}

export function getStoreReviewHandlers(): BridgeHandlerMap {
  return {};
}
