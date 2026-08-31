import type { BridgeHandlerMap } from './bridge-dispatcher';

export interface LoadMessage {
  tracks: { index: number; url: string; title?: string }[];
  startIndex: number;
  rate: number;
  metadata: {
    bookTitle: string;
    authorName: string;
    coverUrl: string;
  };
  // Segments to keep on disk ahead of the playhead. Web decides it because only
  // web knows entitlement and TTS trial quota; omitted means 1, i.e. no
  // prefetch, which is what every build predating this field gets.
  prefetchCount?: number;
  // Joins these audio events to the web app's tts_* events,
  // which are the only side holding book, voice, entitlement and trial context.
  // Absent on builds predating this field, and on non-TTS loads.
  ttsSessionId?: string;
}

export function setupPlayer(): Promise<void>;
export function handleLoad(msg: LoadMessage): Promise<void>;
export function handlePause(): void;
export function handleResume(): void;
export function handleStop(): void;
export function handleSkipTo(index: number): void;
export function handleSetRate(rate: number): void;
export function handleSeekTo(position: number): Promise<void>;
export function getAudioHandlers(): BridgeHandlerMap;
export function registerEventListeners(sendToWebView: (data: object) => void): () => void;
