// Web stub — the audio bridge is native-only, so on web these are never used.
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('blocking');
    return u.toString();
  } catch {
    return url;
  }
}

export function initAudioCache(): void {}

export function getCachedAudioUri(_url: string): string | null {
  return null;
}

export function ensureCachedAudio(
  _url: string,
  _headers?: Record<string, string>,
): Promise<string | null> {
  return Promise.resolve(null);
}

export function evictCachedAudio(_url: string): void {}

export function clearAudioCache(): void {}
