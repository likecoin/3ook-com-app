import type { BridgeHandlerMap } from './bridge-dispatcher';

export type StoreReviewReason =
  | 'book_finished'
  | 'engaged_return'
  | 'purchase_confirmed'
  | 'web';

export function recordListening(ms: number): void;
export function setAudioActive(isActive: boolean): void;
export function armStoreReview(reason: StoreReviewReason): void;
export function startStoreReviewWatcher(): () => void;
export function getStoreReviewHandlers(): BridgeHandlerMap;
