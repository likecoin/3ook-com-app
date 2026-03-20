import CookieManager from '@preeternal/react-native-cookie-manager';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';
import { File, Paths } from 'expo-file-system';

type SendToWebView = (data: object) => void;

interface TrackInfo {
  index: number;
  url: string;
  title?: string;
}

export interface LoadMessage {
  tracks: TrackInfo[];
  startIndex: number;
  rate: number;
  metadata: {
    bookTitle: string;
    authorName: string;
    coverUrl: string;
  };
}

interface QueueTrack {
  uri: string;
  headers?: Record<string, string>;
  title: string;
  artist: string;
  artworkUrl: string;
}

let player: AudioPlayer | null = null;
let queue: QueueTrack[] = [];
let currentIndex = -1;
let currentRate = 1;
let lastFinishTime = 0;
let loadPromise: Promise<void> = Promise.resolve();
let notifyWebView: SendToWebView | null = null;

let tempFiles: File[] = [];
let downloadAbort: AbortController | null = null;
let pendingPause = false;

// TODO: Remove this once the blocking param is no longer used in the web app.
// This is to support streaming without breaking older version of app.
function stripBlockingParam(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('blocking');
    return u.toString();
  } catch {
    return url;
  }
}

function getOrCreatePlayer(): AudioPlayer {
  if (!player) {
    player = createAudioPlayer();
  }
  return player;
}

function cleanupTempFiles(): void {
  for (const f of tempFiles) {
    try {
      f.delete();
    } catch {
      // Best-effort cleanup
    }
  }
  tempFiles = [];
}

async function downloadTrack(
  track: QueueTrack,
  index: number,
  abortSignal?: AbortSignal,
): Promise<string> {
  const ext = track.uri.match(/\.(\w+)(\?|$)/)?.[1] || 'mp3';
  const dest = new File(Paths.cache, `track-${index}-${Date.now()}.${ext}`);
  const downloaded = await File.downloadFileAsync(track.uri, dest, {
    headers: track.headers,
  });
  if (abortSignal?.aborted) {
    try {
      downloaded.delete();
    } catch {
      // Best-effort cleanup
    }
    return downloaded.uri;
  }
  tempFiles.push(downloaded);
  return downloaded.uri;
}

function playTrack(p: AudioPlayer, track: QueueTrack, localUri?: string): void {
  if (localUri) {
    p.replace({ uri: localUri });
  } else {
    p.replace({ uri: track.uri, headers: track.headers });
  }
  p.setPlaybackRate(currentRate);
  p.setActiveForLockScreen(true, {
    title: track.title,
    artist: track.artist,
    artworkUrl: track.artworkUrl,
  });
  p.play();
}

/**
 * Cancel any in-flight download, clean up temp files, download the given track,
 * and play it. Sets lock screen metadata and emits buffering state immediately.
 * Calls `onBeforePlay` (e.g. to emit trackChanged) after download but before play.
 */
async function downloadAndPlay(
  p: AudioPlayer,
  track: QueueTrack,
  index: number,
  onBeforePlay?: () => void,
): Promise<void> {
  downloadAbort?.abort();
  cleanupTempFiles();
  const abort = new AbortController();
  downloadAbort = abort;
  pendingPause = false;

  p.setActiveForLockScreen(true, {
    title: track.title,
    artist: track.artist,
    artworkUrl: track.artworkUrl,
  });
  notifyWebView?.({ type: 'playbackState', state: 'buffering' });

  const localUri = await downloadTrack(track, index, abort.signal);
  if (abort.signal.aborted) return;

  onBeforePlay?.();
  if (pendingPause) return;
  playTrack(p, track, localUri);
}

let setupDone: Promise<void> | null = null;

export function setupPlayer(): Promise<void> {
  if (!setupDone) {
    setupDone = setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).then(() => {
      getOrCreatePlayer();
    });
  }
  return setupDone;
}

export function handleLoad(msg: LoadMessage): Promise<void> {
  loadPromise = loadPromise.then(() => doLoad(msg)).catch(() => doLoad(msg));
  return loadPromise;
}

async function doLoad(msg: LoadMessage): Promise<void> {
  await setupPlayer();
  const p = getOrCreatePlayer();

  const cookieUrl = msg.tracks[0]?.url;
  let cookieHeader = '';
  if (cookieUrl) {
    try {
      const cookies = await CookieManager.get(cookieUrl);
      cookieHeader = Object.entries(cookies)
        .map(([name, cookie]) => `${name}=${cookie.value}`)
        .join('; ');
    } catch {
      // Cookies unavailable — proceed without them
    }
  }
  const headers = cookieHeader ? { Cookie: cookieHeader } : undefined;

  queue = msg.tracks.map((t) => ({
    uri: stripBlockingParam(t.url),
    headers,
    title: t.title || msg.metadata.bookTitle,
    artist: msg.metadata.authorName,
    artworkUrl: msg.metadata.coverUrl,
  }));

  currentIndex = msg.startIndex;
  currentRate = msg.rate;
  lastFinishTime = 0;

  await downloadAndPlay(p, queue[currentIndex], currentIndex);
}

export async function handlePause(): Promise<void> {
  if (player) {
    player.pause();
    // Flag pause-during-download so we don't auto-play after download completes
    if (downloadAbort && !downloadAbort.signal.aborted) {
      pendingPause = true;
    }
  }
}

export async function handleResume(): Promise<void> {
  if (pendingPause && player && currentIndex >= 0 && currentIndex < queue.length) {
    pendingPause = false;
    await downloadAndPlay(player, queue[currentIndex], currentIndex);
  } else {
    pendingPause = false;
    player?.play();
  }
}

export async function handleStop(): Promise<void> {
  downloadAbort?.abort();
  cleanupTempFiles();
  if (player) {
    player.pause();
    player.setActiveForLockScreen(false);
    currentIndex = -1;
    queue = [];
  }
}

export async function handleSkipTo(index: number): Promise<void> {
  if (!player || index < 0 || index >= queue.length) return;

  const lastIndex = currentIndex;
  currentIndex = index;

  await downloadAndPlay(player, queue[currentIndex], currentIndex, () => {
    notifyWebView?.({
      type: 'trackChanged',
      index: currentIndex,
      lastIndex,
    });
  });
}

export async function handleSetRate(rate: number): Promise<void> {
  currentRate = rate;
  player?.setPlaybackRate(rate);
}

export async function handleSeekTo(position: number): Promise<void> {
  await player?.seekTo(position);
}

export function registerEventListeners(sendToWebView: SendToWebView) {
  notifyWebView = sendToWebView;
  const p = getOrCreatePlayer();

  const sub = p.addListener('playbackStatusUpdate', (status) => {
    // Map expo-audio status to RNTP-compatible state strings
    let state: string;
    if (!status.isLoaded) {
      state = 'loading';
    } else if (status.isBuffering) {
      state = 'buffering';
    } else if (status.playing) {
      state = 'playing';
    } else {
      state = 'paused';
    }
    notifyWebView?.({ type: 'playbackState', state });

    // Auto-advance on track finish (debounce for Android duplicate events)
    if (status.didJustFinish) {
      const now = Date.now();
      if (now - lastFinishTime < 500) return;
      lastFinishTime = now;

      const lastIndex = currentIndex;
      if (currentIndex < queue.length - 1) {
        currentIndex++;
        const track = queue[currentIndex];

        downloadAndPlay(p, track, currentIndex, () => {
          notifyWebView?.({
            type: 'trackChanged',
            index: currentIndex,
            lastIndex,
          });
        }).catch(() => {
          // Download failed — restore index and notify WebView so UI can recover
          currentIndex = lastIndex;
          notifyWebView?.({ type: 'playbackState', state: 'paused' });
        });
      } else {
        notifyWebView?.({
          type: 'queueEnded',
          track: lastIndex,
          position: status.currentTime,
        });
      }
    }
  });

  return () => {
    sub.remove();
    notifyWebView = null;
  };
}
