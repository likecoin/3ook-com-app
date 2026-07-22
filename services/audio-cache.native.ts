import { Directory, File, Paths } from 'expo-file-system';

import { watchFeatureFlag } from './analytics';

// Local disk cache for TTS segment audio. Every segment the player fetches is
// mirrored to disk keyed by a hash of its URL, so already-played segments
// replay without a network round trip (offline resilience), bounded by a byte
// budget and evicted oldest-written-first so it can't grow without limit.

// Kill-switches for the whole cache-as-played path — when off, the player
// streams every segment as before, without touching disk.
// CACHE_ENABLED is the build-time override (covers a fault that lands before
// flags can load); the PostHog flag disables the cache in the field without a
// release. An unresolved flag leaves the cache on, matching the shipped
// default, so only an explicit `false` turns it off.
const CACHE_ENABLED = true;
const CACHE_FLAG_KEY = 'app-tts-audio-cache';

let cacheFlag: boolean | undefined;
watchFeatureFlag(CACHE_FLAG_KEY, (enabled) => {
  cacheFlag = enabled;
});

// Gates reads as well as writes, so flipping the flag off also stops the player
// from using entries already on disk (the reason to kill the cache is usually
// that an entry plays badly). Existing files are left for eviction and logout
// to reclaim rather than deleted here.
function cacheEnabled(): boolean {
  return CACHE_ENABLED && cacheFlag !== false;
}

const CACHE_DIR_NAME = 'tts-audio';

// ~150 MB. A segment MP3 is a few KB to tens of KB, so this holds thousands of
// segments — many books' worth of already-heard audio.
const MAX_CACHE_BYTES = 150 * 1024 * 1024;

// Dedup concurrent downloads of the same segment (preload and play can race on
// the same track around a swap). Holds the in-flight promise so a second caller
// awaits the first download instead of starting its own.
const inFlight = new Map<string, Promise<string | null>>();

// Keys evicted while their download was still running, so the download discards
// its result rather than republishing bytes that just failed to play.
const evicted = new Set<string>();

// Bumped by clearAudioCache so downloads in flight during a logout discard
// their result instead of repopulating the cache under another account.
let cacheGeneration = 0;

// Cached dir handle so steady-state lookups avoid re-statting the directory.
// Reset on clearAudioCache().
let cacheDirInstance: Directory | null = null;

// cyrb53 — fast non-cryptographic 53-bit hash. Two seeds are concatenated for a
// ~106-bit, filesystem-safe key, so URL collisions are effectively impossible.
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Cache-key normalizer, not a request URL. The blocking param varies by
// platform (iOS plays blocking=1, Android strips it) but does not change the
// audio bytes, so drop it before hashing and both platforms converge on one
// entry. Shared with the player, which also uses it as the Android play URI.
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('blocking');
    return u.toString();
  } catch {
    return url;
  }
}

// Request URL for cache downloads, always the blocking variant. The server
// returns a complete content-length-delimited buffer there, while its default
// streaming path is chunked — a drop mid-stream would leave a truncated file
// that still starts with a valid header. The streaming path also deletes the
// server's own cached object when a client disconnects, so an abandoned mirror
// download would force a full TTS regeneration for the next listener.
function withBlocking(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('blocking', '1');
    return u.toString();
  } catch {
    return url;
  }
}

function keyFor(url: string): string {
  const s = normalizeUrl(url);
  return `${cyrb53(s, 1).toString(36)}${cyrb53(s, 2).toString(36)}`;
}

function cacheDir(): Directory {
  if (cacheDirInstance) return cacheDirInstance;
  const dir = new Directory(Paths.cache, CACHE_DIR_NAME);
  if (!dir.exists) {
    try {
      dir.create({ intermediates: true });
    } catch {
      // A racing caller may have created it between the check and here.
    }
  }
  cacheDirInstance = dir;
  return dir;
}

function fileForKey(key: string): File {
  return new File(cacheDir(), `${key}.mp3`);
}

export function getCachedAudioUri(url: string): string | null {
  if (!cacheEnabled()) return null;
  try {
    const file = fileForKey(keyFor(url));
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

// Smaller than any real segment, so a body this short is a truncation or an
// error page rather than audio. A backstop only: cache downloads request the
// blocking variant, which the server sends complete and content-length
// delimited, so a short body should not survive the download in the first place.
const MIN_SEGMENT_BYTES = 1024;

// Reject non-audio response bodies (e.g. a login page reached via redirect
// after Cloudflare Access session expiry) before they enter the cache.
// Accepts an ID3 tag or an MPEG frame sync in the first bytes.
function looksLikeMpegAudio(file: File): boolean {
  if (file.size < MIN_SEGMENT_BYTES) return false;
  const handle = file.open();
  try {
    const bytes = handle.readBytes(3);
    if (bytes.length < 3) return false;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // 'ID3'
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  } finally {
    handle.close();
  }
}

// Download the segment to disk if it isn't already there, resolving to its
// local file:// URI — or null if caching is off, or the download failed or
// produced something that isn't audio. Never rejects: callers fall back to
// streaming the network URL on null.
export function ensureCachedAudio(
  url: string,
  headers?: Record<string, string>,
): Promise<string | null> {
  if (!cacheEnabled()) return Promise.resolve(null);
  const key = keyFor(url);
  const pending = inFlight.get(key);
  if (pending) return pending;

  let file: File;
  let part: File;
  const gen = cacheGeneration;
  try {
    file = fileForKey(key);
    if (file.exists) return Promise.resolve(file.uri);
    // Android streams the response body straight to the destination path, so
    // download to a .part file and rename into place only after validation —
    // the published .mp3 is then never truncated or non-audio.
    // Generation suffix: a post-clear retry must never share a path with a
    // pre-clear writer; idempotent overwrites a stale .part from a prior kill.
    part = new File(cacheDir(), `${key}.${gen}.part`);
  } catch {
    // Filesystem unavailable — report a miss so the caller streams instead.
    return Promise.resolve(null);
  }

  const download = File.downloadFileAsync(withBlocking(url), part, {
    idempotent: true,
    ...(headers ? { headers } : {}),
  })
    .then(() => {
      // Cache was cleared (logout) while downloading — discard the result.
      if (gen !== cacheGeneration) throw new Error('cache cleared');
      // Evicted mid-download (playback failed on these very bytes).
      if (evicted.delete(key)) throw new Error('evicted');
      if (!looksLikeMpegAudio(part)) throw new Error('not audio');
      part.move(file);
      return file.uri;
    })
    .catch(() => {
      tryDelete(part);
      return null;
    })
    .finally(() => {
      evicted.delete(key);
      // After a clear this key belongs to post-clear downloads; only the
      // current generation may release the dedup slot.
      if (gen === cacheGeneration) inFlight.delete(key);
    });

  inFlight.set(key, download);
  return download;
}

// Best-effort delete; returns false when the file survives.
function tryDelete(file: File): boolean {
  try {
    if (file.exists) file.delete();
    return true;
  } catch {
    return false;
  }
}

// Drop one cached segment, e.g. after it failed to play, so the next attempt
// streams fresh bytes instead of retrying a corrupt file.
export function evictCachedAudio(url: string): void {
  const key = keyFor(url);
  // A download already in flight would republish the same (possibly corrupt)
  // bytes right after this delete, so mark it to discard its result instead.
  if (inFlight.has(key)) evicted.add(key);
  try {
    tryDelete(fileForKey(key));
  } catch {
    // Best-effort; fileForKey needs the cache dir, which may be unavailable.
  }
}

// Cache files with a known size, for the launch-time sweep.
function sizedEntries(): { file: File; size: number; modifiedAt: number }[] {
  const entries: { file: File; size: number; modifiedAt: number }[] = [];
  for (const entry of cacheDir().list()) {
    if (!(entry instanceof File)) continue;
    const info = entry.info();
    if (typeof info.size !== 'number') continue;
    entries.push({ file: entry, size: info.size, modifiedAt: info.modificationTime ?? 0 });
  }
  return entries;
}

let sweepScheduled = false;

// Reclaim disk once per launch, off the playback path. A session adds at most
// a few MB (segments are KB-scale and arrive one per segment played), so the
// budget only has to hold across launches — which means no running total and
// no directory sweep while audio is playing. Nothing is in flight this early,
// so every .part is an orphan from a killed process.
export function initAudioCache(): void {
  if (sweepScheduled) return;
  sweepScheduled = true;
  // Deferred so a cold start's first frame never waits on the filesystem.
  setTimeout(() => {
    try {
      const entries: { file: File; size: number; modifiedAt: number }[] = [];
      let total = 0;
      for (const entry of sizedEntries()) {
        if (entry.file.name.endsWith('.part')) {
          tryDelete(entry.file);
          continue;
        }
        total += entry.size;
        entries.push(entry);
      }
      if (total <= MAX_CACHE_BYTES) return;

      entries.sort((a, b) => a.modifiedAt - b.modifiedAt);
      for (const entry of entries) {
        if (total <= MAX_CACHE_BYTES) break;
        try {
          entry.file.delete();
          total -= entry.size;
        } catch {
          // Skip a file we can't delete; the next launch retries it.
        }
      }
    } catch {
      // Never let cache maintenance break startup.
    }
  }, 0);
}

export function clearAudioCache(): void {
  try {
    const dir = cacheDirInstance ?? new Directory(Paths.cache, CACHE_DIR_NAME);
    if (dir.exists) dir.delete();
  } catch {
    // Best-effort; a failed clear just leaves eviction to reclaim space later.
  } finally {
    cacheDirInstance = null;
    // Invalidate in-flight downloads so a completion after logout is
    // discarded (see cacheGeneration) and dedup state can't go stale.
    inFlight.clear();
    evicted.clear();
    cacheGeneration += 1;
  }
}
