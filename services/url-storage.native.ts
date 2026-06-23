import { File, Paths } from 'expo-file-system';

import { isExternalBrowserHost } from './external-hosts';

const storageFile = new File(Paths.document, 'last-url.json');
const BASE_URL = 'https://3ook.com';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
// Refresh the persisted timestamp at most once per hour when the URL is
// unchanged, so getInitialURL's staleness check reflects "last visited", not
// "last URL change".
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface StoredURL {
  url: string;
  timestamp: number;
}

function is3ookURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    // Never persist/restore browser-only subdomains (e.g. docs.3ook.com). This
    // also recovers users already trapped on a saved docs URL: on relaunch the
    // stored value fails here and getInitialURL falls back to the home page.
    if (isExternalBrowserHost(parsed.hostname)) return false;
    return (
      parsed.hostname === '3ook.com' || parsed.hostname.endsWith('.3ook.com')
    );
  } catch {
    return false;
  }
}

function ensureAppParam(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('app', '1');
    return parsed.toString();
  } catch {
    return url;
  }
}

let lastSavedURL: string | null = null;
let lastSavedAt = 0;

export function saveLastURL(url: string): void {
  if (!is3ookURL(url)) return;
  const now = Date.now();
  if (url === lastSavedURL && now - lastSavedAt < REFRESH_INTERVAL_MS) return;
  lastSavedURL = url;
  lastSavedAt = now;
  try {
    storageFile.write(JSON.stringify({ url, timestamp: now }));
  } catch (e) {
    console.warn('[url-storage] write failed:', e);
  }
}

export function resolveDeepLinkURL(url: string | null | undefined): string | null {
  if (!url || !is3ookURL(url)) return null;
  return ensureAppParam(url);
}

export async function getInitialURL(): Promise<string> {
  const fallback = `${BASE_URL}?app=1`;
  try {
    const raw = await storageFile.text();
    const data: StoredURL = JSON.parse(raw);
    const now = Date.now();
    if (!Number.isFinite(data.timestamp) || data.timestamp > now) return fallback;
    if (now - data.timestamp > MAX_AGE_MS) return fallback;
    if (!is3ookURL(data.url)) return fallback;
    return ensureAppParam(data.url);
  } catch {
    return fallback;
  }
}
