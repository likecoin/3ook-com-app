import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

interface BatteryOptimizationModule {
  isExempt(): boolean;
  requestExemption(): void;
}

const NativeModule =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<BatteryOptimizationModule>('BatteryOptimization')
    : null;

// Guard against re-prompting users who declined the system dialog —
// isExempt() stays false in that case, so without this every call would
// re-trigger the prompt.
let requested = false;

/**
 * Shows the system dialog asking the user to exempt the app from battery
 * optimization. No-op if already exempt, already requested this session,
 * or not on Android.
 */
export function requestBatteryOptimizationExemption(): void {
  if (requested) return;
  requested = true;
  if (NativeModule && !NativeModule.isExempt()) {
    NativeModule.requestExemption();
  }
}
