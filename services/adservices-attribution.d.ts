import type { InstallAttribution } from './install-attribution';

// Exchanges the Apple AdServices token for campaign attribution on first launch
// (iOS only), forwards it to analytics, and returns it for the webview bridge.
// Resolves null unless this install is attributed — including while retrying.
export function captureAdServicesAttribution(): Promise<InstallAttribution | null>;
