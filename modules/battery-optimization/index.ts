import { requireNativeModule, Platform } from 'expo-modules-core';

const NativeModule =
  Platform.OS === 'android'
    ? requireNativeModule('BatteryOptimization')
    : null;

/**
 * Returns true if the app is already exempt from battery optimization.
 * Always returns true on non-Android platforms.
 */
export function isExemptFromBatteryOptimization(): boolean {
  return NativeModule?.isExempt() ?? true;
}

/**
 * Shows the system dialog asking the user to exempt the app from battery
 * optimization. No-op if already exempt or not on Android.
 */
export function requestBatteryOptimizationExemption(): void {
  if (NativeModule && !NativeModule.isExempt()) {
    NativeModule.requestExemption();
  }
}
