export interface LoadMessage {
  tracks: { index: number; url: string; title?: string }[];
  startIndex: number;
  rate: number;
  metadata: {
    bookTitle: string;
    authorName: string;
    coverUrl: string;
  };
}

export async function setupPlayer(): Promise<void> {}
export async function handleLoad(_msg: LoadMessage): Promise<void> {}
export function handlePause(): void {}
export function handleResume(): void {}
export function handleStop(): void {}
export function handleSkipTo(_index: number): void {}
export function handleSetRate(_rate: number): void {}
export async function handleSeekTo(_position: number): Promise<void> {}
import type { BridgeHandlerMap } from './bridge-dispatcher';

export function getAudioHandlers(): BridgeHandlerMap {
  return {};
}
export function registerEventListeners(_sendToWebView: (data: object) => void) {
  return () => {};
}
