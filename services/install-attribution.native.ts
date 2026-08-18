import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { captureAdServicesAttribution } from './adservices-attribution';
import { registerSuperProperties, trackEvent } from './analytics';
import { sanitizeAttribution } from './attribution-keys';
import type { InstallAttribution } from './install-attribution';

// The Play Install Referrer is one-shot per install, so capture it once and
// persist the parsed result to avoid re-querying on every launch.
const markerFile = new File(Paths.document, 'install-referrer.json');

async function readStored(): Promise<InstallAttribution | null> {
  try {
    const data = JSON.parse(await markerFile.text());
    if (
      data
      && typeof data.installedAt === 'number'
      && data.attribution
      && typeof data.attribution === 'object'
      && !Array.isArray(data.attribution)
    ) {
      // Sanitize a possibly-corrupted marker (mirrors the capture path), so
      // unexpected/dangerous keys or non-string types can't reach consumers.
      const attribution = sanitizeAttribution(data.attribution);
      return {
        attribution,
        installedAt: data.installedAt,
        // Guard the money-routing field too: never propagate a non-string or
        // empty value into the bridge / backend `from` (matches capture).
        affiliateFrom:
          typeof data.affiliateFrom === 'string' && data.affiliateFrom.length > 0
            ? data.affiliateFrom
            : undefined,
      };
    }
  } catch {
    // No marker yet, or unreadable — treat as not-captured.
  }
  return null;
}

export async function captureInstallAttribution(): Promise<InstallAttribution | null> {
  // iOS has no Install Referrer equivalent; Apple attribution comes from the
  // AdServices token exchange instead, which owns its own marker and retries.
  if (Platform.OS === 'ios') return captureAdServicesAttribution();
  if (Platform.OS !== 'android') return null;

  // Later launches: return the persisted capture so the bridge re-exposes it.
  const stored = await readStored();
  if (stored) return stored;

  let referrer = '';
  try {
    referrer = await Application.getInstallReferrerAsync();
  } catch (e) {
    console.warn('[install-attribution] getInstallReferrerAsync failed', e);
    // Fall through to persist an empty marker so we don't re-query later.
    referrer = '';
  }

  // Play returns a query-param string ("utm_source=x&utm_medium=y").
  let parsed: Record<string, string> = {};
  try {
    parsed = Object.fromEntries(new URLSearchParams(referrer));
  } catch (e) {
    console.warn('[install-attribution] failed to parse install referrer', e);
  }
  const attribution = sanitizeAttribution(parsed);
  // `from` is the affiliate/channel id (money-routing). Kept separate from the
  // analytics `attribution` map so it never feeds the last-touch UTM fallback.
  const affiliateFrom = parsed.from || undefined;
  const result: InstallAttribution = { attribution, installedAt: Date.now(), affiliateFrom };

  // Persist (even when empty) so we don't re-query on later launches.
  try {
    markerFile.write(JSON.stringify({ ...result, referrer }));
  } catch (e) {
    console.warn('[install-attribution] marker write failed', e);
  }

  if (Object.keys(attribution).length) {
    // Durable on the device so every later native event carries the source.
    registerSuperProperties(attribution);
    // Analytics-safe `attribution` only — never the raw referrer, which carries
    // the money-routing `from`.
    trackEvent('install_referrer_captured', attribution);
  }
  return result;
}
