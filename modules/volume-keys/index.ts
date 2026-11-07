import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

export type VolumeKeyDirection = 'up' | 'down';

interface VolumeKeysModule {
  setEnabled(enabled: boolean): void;
  addListener(
    event: 'onVolumeKeyPressed',
    listener: (event: { direction: VolumeKeyDirection }) => void,
  ): { remove(): void };
}

const NativeModule =
  Platform.OS === 'ios' || Platform.OS === 'android'
    ? requireOptionalNativeModule<VolumeKeysModule>('VolumeKeys')
    : null;

export function isVolumeKeysSupported(): boolean {
  return !!NativeModule;
}

/**
 * While enabled, volume key presses are reported to listeners instead of
 * changing the volume. Starts disabled.
 */
export function setVolumeKeysEnabled(enabled: boolean): void {
  NativeModule?.setEnabled(enabled);
}

export function addVolumeKeyListener(
  listener: (event: { direction: VolumeKeyDirection }) => void,
) {
  return NativeModule?.addListener('onVolumeKeyPressed', listener) ?? { remove() {} };
}
