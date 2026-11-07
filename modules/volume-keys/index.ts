import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

export type VolumeKeyDirection = 'up' | 'down';

interface VolumeKeysModule {
  setEnabled(enabled: boolean): void;
  addListener(
    event: 'onVolumeKeyPressed',
    listener: (event: { direction: VolumeKeyDirection }) => void,
  ): { remove(): void };
}

// Android only: iOS has no API for volume button presses, and faking one
// by watching the system volume risks App Store rejection (Guideline 2.5.9).
const NativeModule =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<VolumeKeysModule>('VolumeKeys')
    : null;

export function isVolumeKeysSupported(): boolean {
  return !!NativeModule;
}

/**
 * While enabled, volume key presses are reported to listeners instead of
 * changing the volume. Starts disabled; a no-op where unsupported.
 */
export function setVolumeKeysEnabled(enabled: boolean): void {
  NativeModule?.setEnabled(enabled);
}

export function addVolumeKeyListener(
  listener: (event: { direction: VolumeKeyDirection }) => void,
) {
  return NativeModule?.addListener('onVolumeKeyPressed', listener) ?? { remove() {} };
}
