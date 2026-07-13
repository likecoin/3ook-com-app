import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import * as StoreReview from 'expo-store-review';
import { AppState } from 'react-native';

import { trackEvent } from './analytics';
import type { BridgeHandlerMap } from './bridge-dispatcher';

export type StoreReviewReason =
  | 'book_finished'
  | 'engaged_return'
  | 'purchase_confirmed'
  | 'web';

// The stores hard-limit the prompt (iOS ~3 per year, reset per app version;
// Play an undocumented quota), so the slot is scarce and non-refundable. Only
// ask someone who has used the app enough to have an opinion.
const MIN_LISTENED_MS = 60 * 60 * 1000; // 60 minutes, lifetime
const MIN_ACTIVE_DAYS = 2; // distinct days with any listening
const COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000; // 90 days between prompts

// A book usually finishes with the screen locked, so the prompt is parked until
// the app is next foregrounded. Past this window the intent expires rather than
// ambushing the user on an unrelated launch days later.
const ARM_WINDOW_MS = 5 * 60 * 1000;

// Let the purchase sheet / success UI finish dismissing. A prompt stacked on
// another modal gets ignored, which still burns a slot.
const PROMPT_DELAY_MS = 2000;

// Listening accrues on a 1s status tick; persist at most this often.
const PERSIST_INTERVAL_MS = 60 * 1000;

// A single playing→paused stretch longer than this is a clock change or a
// suspended timer, not real listening. Drop it rather than inflate the total.
const MAX_CHUNK_MS = 6 * 60 * 60 * 1000;

type Blocker =
  | 'unavailable'
  | 'not_engaged'
  | 'same_version'
  | 'cooldown'
  | 'audio_active'
  | 'window_expired';

interface ReviewState {
  totalListenedMs: number;
  activeDays: number;
  lastActiveDay: string;
  lastPromptedAt: number;
  lastPromptedVersion: string;
}

const storageFile = new File(Paths.document, 'store-review.json');

const EMPTY_STATE: ReviewState = {
  totalListenedMs: 0,
  activeDays: 0,
  lastActiveDay: '',
  lastPromptedAt: 0,
  lastPromptedVersion: '',
};

let state: ReviewState | null = null;
let loadPromise: Promise<ReviewState> | null = null;
// Listening recorded before the state file finished loading. recordListening is
// driven by the audio status callback and cannot await, so it buffers here.
let bufferedMs = 0;
let lastPersistAt = 0;
let dirty = false;
let audioActive = false;
let pending: { reason: StoreReviewReason; at: number } | null = null;
// One prompt at a time. Two triggers arming within the settle delay would
// otherwise race past findBlocker() and spend two of the ~3 yearly slots.
let promptTimer: ReturnType<typeof setTimeout> | null = null;
let requesting = false;

function appVersion(): string {
  return Application.nativeApplicationVersion ?? '';
}

// Local calendar day, not UTC — a listener in Asia/Hong_Kong finishing a
// chapter at 1am should count that as a new day, the way they'd experience it.
function dayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function ensureLoaded(): Promise<ReviewState> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    let loaded: ReviewState = { ...EMPTY_STATE };
    try {
      const parsed = JSON.parse(await storageFile.text()) as Partial<ReviewState>;
      loaded = {
        totalListenedMs: Number(parsed.totalListenedMs) || 0,
        activeDays: Number(parsed.activeDays) || 0,
        lastActiveDay: typeof parsed.lastActiveDay === 'string' ? parsed.lastActiveDay : '',
        lastPromptedAt: Number(parsed.lastPromptedAt) || 0,
        lastPromptedVersion:
          typeof parsed.lastPromptedVersion === 'string' ? parsed.lastPromptedVersion : '',
      };
    } catch {
      // No file yet (first run) or corrupt — start from zero.
    }
    state = loaded;
    if (bufferedMs > 0) {
      applyListening(bufferedMs);
      bufferedMs = 0;
    }
    return loaded;
  })();
  return loadPromise;
}

// File.write is synchronous, and backgrounding is a latency-sensitive suspend
// window — so never write byte-identical JSON. A user who has played no audio
// backgrounds the app without touching the disk at all.
function persist(force = false): void {
  if (!state || !dirty) return;
  const now = Date.now();
  if (!force && now - lastPersistAt < PERSIST_INTERVAL_MS) return;
  lastPersistAt = now;
  try {
    storageFile.write(JSON.stringify(state));
    dirty = false;
  } catch (e) {
    console.warn('[store-review] write failed:', e);
  }
}

function applyListening(ms: number): void {
  if (!state) return;
  state.totalListenedMs += ms;
  const today = dayKey();
  if (state.lastActiveDay !== today) {
    state.lastActiveDay = today;
    state.activeDays += 1;
  }
  dirty = true;
  persist();
}

export function recordListening(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_CHUNK_MS) return;
  if (!state) {
    bufferedMs += ms;
    ensureLoaded().catch(() => {});
    return;
  }
  applyListening(ms);
}

// Pushed down from the audio bridge — store-review must never import audio-bridge
// (audio-bridge imports this), so playback state flows one way.
export function setAudioActive(isActive: boolean): void {
  audioActive = isActive;
  // Throttled, never forced: a buffering stall is a playing→buffering→playing
  // round trip, so forcing a write here would hit the disk on every stall.
  if (!isActive) persist();
}

// Cheap local checks first; the native availability call runs last.
async function findBlocker(): Promise<Blocker | null> {
  const s = await ensureLoaded();
  if (audioActive) return 'audio_active';
  if (s.totalListenedMs < MIN_LISTENED_MS || s.activeDays < MIN_ACTIVE_DAYS) return 'not_engaged';
  // iOS resets its quota per app version, so re-asking within one version is a
  // guaranteed silent no-op.
  if (s.lastPromptedVersion && s.lastPromptedVersion === appVersion()) return 'same_version';
  if (s.lastPromptedAt && Date.now() - s.lastPromptedAt < COOLDOWN_MS) return 'cooldown';
  if (!(await StoreReview.isAvailableAsync())) return 'unavailable';
  return null;
}

// `ambient` marks engaged_return, which runs on every resume: its blockers are
// the expected steady state, so tracking them would emit one skip event per
// resume. Explicitly armed triggers always report why they lost.
async function requestNow(reason: StoreReviewReason, ambient: boolean): Promise<void> {
  // findBlocker awaits, so two concurrent callers would both read the
  // pre-prompt state and both ask — spending two slots on one prompt.
  if (requesting) return;
  requesting = true;
  try {
    const blocker = await findBlocker();
    if (blocker) {
      if (!ambient) trackEvent('store_review_skipped', { reason, blocker });
      return;
    }
    const s = await ensureLoaded();
    // Mark as prompted *before* asking. Neither store reports whether the prompt
    // actually appeared — one swallowed by quota is indistinguishable from one the
    // user saw — so assume it showed. Assuming otherwise would re-prompt forever.
    s.lastPromptedAt = Date.now();
    s.lastPromptedVersion = appVersion();
    dirty = true;
    persist(true);
    trackEvent('store_review_requested', { reason });
    await StoreReview.requestReview();
  } catch (e) {
    console.warn('[store-review] requestReview failed', e);
  } finally {
    requesting = false;
  }
}

// Latest trigger wins: a second arm within the settle delay replaces the first
// rather than queueing a second prompt.
function schedule(reason: StoreReviewReason, ambient: boolean): void {
  if (promptTimer) clearTimeout(promptTimer);
  promptTimer = setTimeout(() => {
    promptTimer = null;
    // The user may have backgrounded the app during the settle delay.
    if (AppState.currentState !== 'active') return;
    requestNow(reason, ambient).catch((e) => console.warn('[store-review] request failed', e));
  }, PROMPT_DELAY_MS);
}

export function armStoreReview(reason: StoreReviewReason): void {
  if (AppState.currentState === 'active') {
    pending = null;
    schedule(reason, false);
    return;
  }
  pending = { reason, at: Date.now() };
}

export function startStoreReviewWatcher(): () => void {
  ensureLoaded().catch(() => {});
  let wasBackgrounded = false;
  // Only fires on transitions, so a cold start can't trigger a prompt while the
  // WebView is still loading.
  const sub = AppState.addEventListener('change', (next) => {
    // 'inactive' is a transient peek (Control Center, a call banner), not a
    // real departure — only 'background' counts as leaving the app.
    if (next === 'background') {
      wasBackgrounded = true;
      persist(true);
      return;
    }
    if (next !== 'active') return;

    const returned = wasBackgrounded;
    const parked = pending;
    wasBackgrounded = false;
    pending = null;

    // Ambient trigger: an engaged user coming back, no audio playing. Catches
    // the listeners who never quite finish a book.
    if (!parked) {
      if (returned) schedule('engaged_return', true);
      return;
    }
    if (Date.now() - parked.at > ARM_WINDOW_MS) {
      trackEvent('store_review_skipped', { reason: parked.reason, blocker: 'window_expired' });
      return;
    }
    schedule(parked.reason, false);
  });
  return () => {
    sub.remove();
    if (promptTimer) {
      clearTimeout(promptTimer);
      promptTimer = null;
    }
    persist(true);
  };
}

// Reasons the web may name; anything else falls back to a generic 'web'.
const WEB_REASONS: readonly StoreReviewReason[] = ['purchase_confirmed'];

export function getStoreReviewHandlers(): BridgeHandlerMap {
  return {
    // Web sends this once it has confirmed the value landed — after the webhook
    // flips isLikerPlus, not when the purchase call returns. Only the web knows
    // what the user is actually looking at.
    requestStoreReview: (msg) => {
      armStoreReview(WEB_REASONS.find((r) => r === msg.reason) ?? 'web');
    },
  };
}
