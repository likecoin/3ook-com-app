// Local disk cache for TTS segment audio. Native-only; the web build compiles
// against the no-op stub. See audio-cache.native.ts for behaviour.

// Strips the platform-varying `blocking` query param so the player's streamed
// URI and the cache key derive from the same canonical URL.
export function normalizeUrl(url: string): string;

// Reclaim orphaned partial downloads and trim the cache to its byte budget.
// Call once at startup; the work is deferred off the first frame.
export function initAudioCache(): void;

// Returns a local file:// URI if the segment for `url` is already on disk,
// otherwise null. Synchronous (a filesystem stat) so it is safe to call on the
// audio playback hot path.
export function getCachedAudioUri(url: string): string | null;

// Download the segment to disk and resolve to its local file:// URI, or null if
// caching is off or the download failed. Concurrent callers for the same
// segment share one download. Never rejects — null means "stream it instead".
export function ensureCachedAudio(
  url: string,
  headers?: Record<string, string>,
): Promise<string | null>;

// Drop the cached copy of one segment (e.g. after it failed to play).
export function evictCachedAudio(url: string): void;

// Drop all cached audio (e.g. on logout).
export function clearAudioCache(): void;
