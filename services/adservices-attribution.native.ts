import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';

import {
  getAttributionToken,
  isAdServicesAttributionSupported,
  type AdServicesTokenError,
} from '../modules/adservices-attribution';
import { registerSuperProperties, trackEvent } from './analytics';
import { pickStringKeys, sanitizeAttribution } from './attribution-keys';
import type { InstallAttribution } from './install-attribution';

// Separate from the Android install-referrer marker: that one is one-shot
// consume, this is a resumable state machine with retries across launches.
const markerFile = new File(Paths.document, 'install-adservices.json');

const EXCHANGE_URL = 'https://api-adservices.apple.com/api/v1/';

// Apple: the token is valid 24h from install, then the exchange 404s forever.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// Apple's documented guidance for a token that hasn't propagated yet.
const RETRY_DELAY_MS = 5_000;
const MAX_ATTEMPTS_PER_SESSION = 3;
// Roughly four launches' worth, spent only on attempts Apple actually answered.
const MAX_TOTAL_ATTEMPTS = 12;
const EXCHANGE_TIMEOUT_MS = 10_000;

// Apple returns a mock payload with these ids to Xcode and TestFlight builds.
const APPLE_TEST_ID = 1234567890;

// Raw Apple fields, kept local so the shared allowlist can't widen and start
// copying same-named params out of an Android Play referrer string.
const APPLE_ADS_KEYS = [
  'apple_ads_org_id',
  'apple_ads_campaign_id',
  'apple_ads_ad_group_id',
  'apple_ads_ad_id',
  'apple_ads_keyword_id',
  'apple_ads_conversion_type',
  'apple_ads_claim_type',
  'apple_ads_country',
] as const;

type AdServicesStatus =
  | 'pending'
  | 'attributed'
  | 'organic'
  | 'test'
  | 'expired'
  | 'exhausted'
  | 'unsupported';

type TerminalStatus = Exclude<AdServicesStatus, 'pending'>;

const TERMINAL = new Set<AdServicesStatus>([
  'attributed',
  'organic',
  'test',
  'expired',
  'exhausted',
  'unsupported',
]);

const isTerminal = (status: string): status is TerminalStatus =>
  TERMINAL.has(status as AdServicesStatus);

// Why an attempt ended. Surfaced as a PostHog dimension, so it's a closed union
// — a typo would otherwise fragment the breakdown instead of failing the build.
type Reason =
  | 'stale_install'
  | 'ttl'
  | 'budget'
  | 'transport'
  | 'timeout'
  | 'not_found'
  | 'bad_token'
  | 'unparseable'
  | 'no_match'
  | 'test_payload'
  | 'matched'
  | `http_${number}`
  | `token_${AdServicesTokenError}`;

interface AdServicesMarker {
  version: 1;
  status: AdServicesStatus;
  installedAt: number;
  // Only attempts Apple answered with an HTTP status; see attemptOnce.
  attempts: number;
  attribution?: Record<string, string>;
  apple?: Record<string, string>;
  // Gates the one-shot capture event, so a crash between persisting and
  // tracking doesn't lose the event on the next launch.
  delivered?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readMarker(): Promise<AdServicesMarker | null> {
  try {
    const data: unknown = JSON.parse(await markerFile.text());
    if (!data || typeof data !== 'object') return null;
    const raw = data as Record<string, unknown>;
    // Unknown schema: recapture rather than trust fields we can't reason about.
    if (raw.version !== 1) return null;
    const status = typeof raw.status === 'string' ? raw.status : '';
    if (status !== 'pending' && !isTerminal(status)) return null;
    const installedAt = Number(raw.installedAt);
    if (!Number.isFinite(installedAt) || installedAt <= 0) return null;
    const attributed = status === 'attributed';
    return {
      version: 1,
      status,
      installedAt,
      attempts: Number(raw.attempts) || 0,
      attribution: attributed ? sanitizeAttribution(raw.attribution) : undefined,
      apple: attributed ? pickStringKeys(raw.apple, APPLE_ADS_KEYS) : undefined,
      delivered: raw.delivered === true,
    };
  } catch {
    // No marker yet, or unreadable — treat as not-captured.
    return null;
  }
}

// File.write is synchronous, so skip byte-identical rewrites: the retry loop
// otherwise re-persists an unchanged marker on every all-pending session.
let lastSerialized = '';

function writeMarker(marker: AdServicesMarker): void {
  const serialized = JSON.stringify(marker);
  if (serialized === lastSerialized) return;
  try {
    markerFile.write(serialized);
    lastSerialized = serialized;
  } catch (e) {
    console.warn('[adservices] marker write failed', e);
  }
}

// Apple's install time survives app updates, so it's a true TTL anchor. Falls
// back to now(), which only ever makes us retry more, never less.
async function resolveInstallTime(): Promise<number> {
  try {
    return (await Application.getInstallationTimeAsync()).getTime();
  } catch {
    return Date.now();
  }
}

function numeric(value: unknown): string | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : undefined;
}

// Capped because these land as PostHog super properties and RevenueCat
// subscriber attributes, both of which have length limits.
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 64) : undefined;
}

function isTestPayload(payload: Record<string, unknown>): boolean {
  return Number(payload.campaignId) === APPLE_TEST_ID || Number(payload.orgId) === APPLE_TEST_ID;
}

// Mapping onto the existing utm_* keys keeps super properties, the bridge and
// RevenueCat's $campaign/$mediaSource mirror working unchanged. Raw Apple ids
// stay off `attribution` — there they'd become super properties on every event.
function mapPayload(payload: Record<string, unknown>): {
  attribution: Record<string, string>;
  apple: Record<string, string>;
} {
  const attribution: Record<string, string> = { utm_source: 'apple_ads', utm_medium: 'cpc' };
  const campaignId = numeric(payload.campaignId);
  const keywordId = numeric(payload.keywordId);
  const adId = numeric(payload.adId);
  if (campaignId) attribution.utm_campaign = campaignId;
  if (keywordId) attribution.utm_term = keywordId;
  if (adId) attribution.utm_content = adId;

  const apple: Record<string, string> = {};
  const assign = (key: (typeof APPLE_ADS_KEYS)[number], value: string | undefined) => {
    if (value) apple[key] = value;
  };
  assign('apple_ads_org_id', numeric(payload.orgId));
  assign('apple_ads_campaign_id', campaignId);
  assign('apple_ads_ad_group_id', numeric(payload.adGroupId));
  assign('apple_ads_ad_id', adId);
  assign('apple_ads_keyword_id', keywordId);
  assign('apple_ads_conversion_type', text(payload.conversionType));
  assign('apple_ads_claim_type', text(payload.claimType));
  assign('apple_ads_country', text(payload.countryOrRegion));

  return { attribution, apple };
}

type Outcome = { counts: boolean; reason: Reason } & (
  | { kind: 'attributed'; attribution: Record<string, string>; apple: Record<string, string> }
  | { kind: 'terminal'; status: TerminalStatus }
  | { kind: 'pending' }
);

/**
 * `counts` marks whether the attempt consumed the retry budget: a user
 * installing offline shouldn't burn it before their connection returns.
 */
async function attemptOnce(): Promise<Outcome> {
  const result = await getAttributionToken();
  if (!result.token) {
    const error = result.error ?? 'unknown';
    return error === 'unsupported'
      ? { kind: 'terminal', counts: false, reason: 'token_unsupported', status: 'unsupported' }
      : { kind: 'pending', counts: false, reason: `token_${error}` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: result.token,
      signal: controller.signal,
    });
  } catch (e) {
    // A timeout means the network is reachable but stalling, which is worth
    // spending budget on. Being offline isn't — the radio may well come back
    // before the token's 24h TTL runs out.
    const timedOut = (e as Error)?.name === 'AbortError';
    return {
      kind: 'pending',
      counts: timedOut,
      reason: timedOut ? 'timeout' : 'transport',
    };
  } finally {
    clearTimeout(timeout);
  }

  // 404 is ambiguous: not propagated yet, or the token TTL has lapsed. Only
  // elapsed time tells them apart, so the caller's TTL check owns that call.
  if (response.status === 404) {
    return { kind: 'pending', counts: true, reason: 'not_found' };
  }
  if (response.status === 400) {
    return { kind: 'terminal', counts: true, reason: 'bad_token', status: 'unsupported' };
  }
  if (!response.ok) {
    return { kind: 'pending', counts: true, reason: `http_${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'pending', counts: true, reason: 'unparseable' };
  }
  if (!body || typeof body !== 'object') {
    return { kind: 'pending', counts: true, reason: 'unparseable' };
  }

  const payload = body as Record<string, unknown>;
  if (payload.attribution !== true) {
    return { kind: 'terminal', counts: true, reason: 'no_match', status: 'organic' };
  }
  if (isTestPayload(payload)) {
    return { kind: 'terminal', counts: true, reason: 'test_payload', status: 'test' };
  }
  const { attribution, apple } = mapPayload(payload);
  return { kind: 'attributed', counts: true, reason: 'matched', attribution, apple };
}

// Super properties are re-registered on every launch so they survive a PostHog
// storage wipe; the capture event itself fires at most once per install.
function finalize(marker: AdServicesMarker): InstallAttribution | null {
  if (marker.status !== 'attributed' || !marker.attribution) return null;
  const attribution = marker.attribution;
  registerSuperProperties(attribution);
  if (!marker.delivered) {
    trackEvent('install_attribution_captured', {
      ...attribution,
      ...marker.apple,
      attribution_source: 'apple_ads',
    });
    marker.delivered = true;
    writeMarker(marker);
  }
  return { attribution, installedAt: marker.installedAt };
}

function reportStatus(marker: AdServicesMarker, reason: Reason): void {
  trackEvent('adservices_attribution', {
    status: marker.status,
    attempts: marker.attempts,
    ms_since_install: Date.now() - marker.installedAt,
    reason,
  });
}

async function run(): Promise<InstallAttribution | null> {
  // Older binary running newer JS via EAS Update: write no marker at all, so a
  // terminal state can't outlive the build that couldn't have succeeded.
  if (!isAdServicesAttributionSupported()) return null;

  const stored = await readMarker();
  if (stored && isTerminal(stored.status)) return finalize(stored);

  let reason: Reason = 'not_found';
  let marker = stored;
  if (!marker) {
    const installedAt = await resolveInstallTime();
    marker = { version: 1, status: 'pending', installedAt, attempts: 0 };
    // Existing installs updating into this version are already past the TTL;
    // record that without firing provably-doomed requests at Apple.
    if (Date.now() - installedAt >= TOKEN_TTL_MS) {
      marker.status = 'expired';
      reason = 'stale_install';
      writeMarker(marker);
      reportStatus(marker, reason);
      return null;
    }
    writeMarker(marker);
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_SESSION; attempt += 1) {
    // Delay first so the checks below run against the moment the request is
    // actually sent: iOS suspends timers on background, so a resumed session
    // can land here long after the previous attempt.
    if (attempt > 0) await delay(RETRY_DELAY_MS);

    // Covers a resumed marker that crossed the TTL between launches, not just
    // one that lapses mid-session. No token can succeed past this point.
    if (Date.now() - marker.installedAt >= TOKEN_TTL_MS) {
      marker.status = 'expired';
      reason = 'ttl';
      break;
    }
    if (marker.attempts >= MAX_TOTAL_ATTEMPTS) {
      marker.status = 'exhausted';
      reason = 'budget';
      break;
    }

    const outcome = await attemptOnce();
    reason = outcome.reason;
    if (outcome.counts) marker.attempts += 1;

    if (outcome.kind === 'attributed') {
      marker.status = 'attributed';
      marker.attribution = outcome.attribution;
      marker.apple = outcome.apple;
      break;
    }
    if (outcome.kind === 'terminal') {
      marker.status = outcome.status;
      break;
    }
    writeMarker(marker);
  }

  // Catches the budget being spent on the session's last iteration, which the
  // in-loop guard can't see because the loop exits before re-checking.
  if (marker.status === 'pending' && marker.attempts >= MAX_TOTAL_ATTEMPTS) {
    marker.status = 'exhausted';
    reason = 'budget';
  }

  writeMarker(marker);
  // Only report a terminal state, and only on the launch that reached it —
  // a marker read back as terminal returns above without re-reporting.
  if (isTerminal(marker.status)) reportStatus(marker, reason);
  return finalize(marker);
}

// Mirrors configureIAP's singleton guard: a concurrent second run would
// duplicate the token fetch and could deliver the capture event twice.
let inFlight: Promise<InstallAttribution | null> | null = null;

export function captureAdServicesAttribution(): Promise<InstallAttribution | null> {
  inFlight ??= run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
