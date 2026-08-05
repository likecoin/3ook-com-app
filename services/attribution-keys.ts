// Acquisition signals the web/backend consume; click ids ride alongside UTM.
// Shared by the Android install-referrer and iOS AdServices capture paths, so
// it lives in a leaf module both can import without a cycle.
export const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'fbclid',
  'gad_source',
] as const;

// Copies only the given keys with non-empty string values, so unexpected or
// dangerous keys (e.g. `__proto__`) and non-string types can never reach the
// bridge or downstream consumers.
export function pickStringKeys(raw: unknown, keys: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return picked;
  const source = raw as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) picked[key] = value;
  }
  return picked;
}

export function sanitizeAttribution(raw: unknown): Record<string, string> {
  return pickStringKeys(raw, ATTRIBUTION_KEYS);
}
