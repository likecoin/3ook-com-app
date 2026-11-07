import {
  addVolumeKeyListener,
  isVolumeKeysSupported,
  setVolumeKeysEnabled,
} from '../modules/volume-keys';
import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';

export function isVolumeKeyPagingSupported(): boolean {
  return isVolumeKeysSupported();
}

export function getVolumeKeyHandlers(): BridgeHandlerMap {
  return {
    // Web asks for paging only inside the reader with the setting on and TTS
    // idle; anything short of an explicit true hands the keys back to volume.
    setVolumeKeyPaging: (msg) => setVolumeKeysEnabled(msg.enabled === true),
    // Posted by the bootstrap script on every new document: a reloaded page
    // hasn't asked for paging yet, and may never reach the reader to release it.
    documentStart: () => setVolumeKeysEnabled(false),
  };
}

export function registerVolumeKeyEventListeners(send: SendToWebView): () => void {
  const sub = addVolumeKeyListener(({ direction }) => {
    send({ type: 'volumeKeyPressed', direction });
  });
  return () => {
    sub.remove();
    setVolumeKeysEnabled(false);
  };
}
