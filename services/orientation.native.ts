import * as ScreenOrientation from 'expo-screen-orientation';
import { Dimensions, Platform } from 'react-native';

// Android's sw600dp tablet breakpoint. Android 16+ stops honouring an
// activity's orientation lock above it anyway.
const TABLET_MIN_WIDTH_DP = 600;

// Android's manifest lock is one value for every device, so free the large
// screens at runtime instead. iOS needs nothing: the plist's ~ipad key already
// frees iPad while the base key keeps iPhone portrait.
export function startOrientationWatcher(): () => void {
  if (Platform.OS !== 'android') return () => {};

  let unlocked = false;
  // 'screen', not 'window': window shrinks in split-screen and would read a
  // real tablet as a phone. One-way, because re-locking would snap a landscape
  // reader back to portrait the moment a foldable closes.
  const unlockIfLarge = () => {
    const { width, height } = Dimensions.get('screen');
    if (unlocked || Math.min(width, height) < TABLET_MIN_WIDTH_DP) return;
    unlocked = true;
    // unlockAsync maps to UNSPECIFIED, not a forced sensor lock, so the system
    // auto-rotate setting still has the last word.
    ScreenOrientation.unlockAsync().catch((e) => {
      unlocked = false;
      console.warn('[orientation] unlock failed', e);
    });
  };

  // The activity handles fold/rotate via configChanges, so App never remounts —
  // without the listener a foldable opened mid-session stays locked.
  unlockIfLarge();
  const sub = Dimensions.addEventListener('change', unlockIfLarge);
  return () => sub.remove();
}
