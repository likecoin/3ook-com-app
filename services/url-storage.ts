import { File, Paths } from 'expo-file-system';

const storageFile = new File(Paths.document, 'last-url.json');
const BASE_URL = 'https://3ook.com';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
// Refresh the persisted timestamp at most once per hour when the URL is
// unchanged, so getInitialUrl's staleness check reflects "last visited", not
// "last URL change".
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface StoredUrl {
  url: string;
  timestamp: number;
}

function is3ookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
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

let lastSavedUrl: string | null = null;
let lastSavedAt = 0;

export function saveLastUrl(url: string): void {
  if (!is3ookUrl(url)) return;
  const now = Date.now();
  if (url === lastSavedUrl && now - lastSavedAt < REFRESH_INTERVAL_MS) return;
  lastSavedUrl = url;
  lastSavedAt = now;
  try {
    storageFile.write(JSON.stringify({ url, timestamp: now }));
  } catch (e) {
    console.warn('[url-storage] write failed:', e);
  }
}

export async function getInitialUrl(): Promise<string> {
  const fallback = `${BASE_URL}?app=1`;
  try {
    if (!storageFile.exists) return fallback;
    const raw = await storageFile.text();
    const data: StoredUrl = JSON.parse(raw);
    if (Date.now() - data.timestamp > MAX_AGE_MS) return fallback;
    if (!is3ookUrl(data.url)) return fallback;
    return ensureAppParam(data.url);
  } catch {
    return fallback;
  }
}
