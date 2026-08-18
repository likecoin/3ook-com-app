import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

// Terminal on the JS side: no point retrying a device that has no AdServices.
export type AdServicesTokenError = 'network' | 'internal' | 'unsupported' | 'unknown';

export interface AdServicesTokenResult {
  token?: string;
  error?: AdServicesTokenError;
}

interface AdServicesAttributionModule {
  getAttributionToken(): Promise<AdServicesTokenResult>;
}

// iOS-only native module. Apple passes no click id through the App Store, so
// AAAttribution is the only install-attribution source on this platform.
const NativeModule =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<AdServicesAttributionModule>('AdServicesAttribution')
    : null;

// False on an older binary running newer JS via EAS Update, which callers must
// treat as "unknown yet", never as a terminal outcome.
export function isAdServicesAttributionSupported(): boolean {
  return !!NativeModule;
}

// Resolves `{ token }` or `{ error }` — never rejects. Reports `unsupported`
// where the native module is unavailable.
export function getAttributionToken(): Promise<AdServicesTokenResult> {
  return NativeModule?.getAttributionToken() ?? Promise.resolve({ error: 'unsupported' });
}
