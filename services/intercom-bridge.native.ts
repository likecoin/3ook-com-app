import type { EmitterSubscription } from 'react-native';
import { DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from 'react-native';

import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';

type IntercomModuleType = typeof import('@intercom/intercom-react-native');
type IntercomDefault = IntercomModuleType['default'];
type UserAttributes = import('@intercom/intercom-react-native').UserAttributes;

// `@intercom/intercom-react-native`'s JS wrapper asserts on NativeModules at
// module-eval time, so a build without the config plugin would crash on import.
// Resolve once via gated `require` and degrade to no-ops if the native module
// isn't linked.
type LoadedIntercom = { Intercom: IntercomDefault; events: IntercomModuleType['IntercomEvents'] };
const loadedIntercom: LoadedIntercom | null = (() => {
  if (!NativeModules.IntercomModule) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@intercom/intercom-react-native') as IntercomModuleType;
    return { Intercom: mod.default, events: mod.IntercomEvents };
  } catch (e) {
    console.warn('[intercom] failed to load module', e);
    return null;
  }
})();

export function isIntercomAvailable(): boolean {
  return loadedIntercom !== null;
}

async function safeCall<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[intercom] ${label} failed`, e);
    return undefined;
  }
}

export function getIntercomHandlers(): BridgeHandlerMap {
  if (!loadedIntercom) return {};
  const { Intercom } = loadedIntercom;

  return {
    intercomShow: async () => {
      await safeCall('present', () => Intercom.present());
    },

    intercomShowNewMessage: async (msg) => {
      const initial = typeof msg.message === 'string' ? msg.message : undefined;
      await safeCall('presentMessageComposer', () => Intercom.presentMessageComposer(initial));
    },

    intercomLogout: async () => {
      await safeCall('logout', () => Intercom.logout());
    },

    intercomTrackEvent: async (msg) => {
      const name = typeof msg.name === 'string' ? msg.name : undefined;
      if (!name) return;
      const metaData =
        msg.metaData && typeof msg.metaData === 'object'
          ? (msg.metaData as Record<string, unknown>)
          : undefined;
      await safeCall('logEvent', () => Intercom.logEvent(name, metaData));
    },
  };
}

export function wrapIdentityHandlers(base: BridgeHandlerMap): BridgeHandlerMap {
  if (!loadedIntercom) return base;
  const { Intercom } = loadedIntercom;

  async function intercomIdentify(msg: Record<string, unknown>) {
    const intercomToken =
      typeof msg.intercomToken === 'string' ? msg.intercomToken : undefined;
    // Without a JWT we cannot safely identify against an Identity-Verified
    // workspace. Skip rather than create a noisy anonymous record.
    if (!intercomToken) return;

    const userId =
      typeof msg.likerId === 'string'
        ? msg.likerId
        : typeof msg.userId === 'string'
          ? msg.userId
          : undefined;
    const email = typeof msg.email === 'string' ? msg.email : undefined;
    if (!userId && !email) return;

    // setUserJwt must be called before loginUserWithUserAttributes for
    // JWT verification to take effect.
    await safeCall('setUserJwt', () => Intercom.setUserJwt(intercomToken));
    const attrs: UserAttributes = {
      userId,
      email,
      name: typeof msg.displayName === 'string' ? msg.displayName : undefined,
      customAttributes: {
        evm_wallet: typeof msg.evmWallet === 'string' ? msg.evmWallet : undefined,
        like_wallet: typeof msg.likeWallet === 'string' ? msg.likeWallet : undefined,
        is_liker_plus: !!msg.isLikerPlus,
        login_method: typeof msg.loginMethod === 'string' ? msg.loginMethod : undefined,
        locale: typeof msg.locale === 'string' ? msg.locale : undefined,
      },
    };
    await safeCall('loginUserWithUserAttributes', () =>
      Intercom.loginUserWithUserAttributes(attrs)
    );
  }

  async function intercomReset() {
    await safeCall('logout', () => Intercom.logout());
  }

  return {
    ...base,
    identifyUser: async (msg) => {
      await Promise.all([base.identifyUser?.(msg), intercomIdentify(msg)]);
    },
    resetUser: async (msg) => {
      await Promise.all([base.resetUser?.(msg), intercomReset()]);
    },
  };
}

export function registerIntercomEventListeners(send: SendToWebView): () => void {
  if (!loadedIntercom) return () => {};
  const { events } = loadedIntercom;

  let emitter: NativeEventEmitter | typeof DeviceEventEmitter;
  if (Platform.OS === 'ios') {
    const iosEmitter = NativeModules.IntercomEventEmitter;
    if (!iosEmitter) {
      console.warn('[intercom] IntercomEventEmitter unavailable; skipping event listeners');
      return () => {};
    }
    try {
      emitter = new NativeEventEmitter(iosEmitter);
    } catch (e) {
      console.warn('[intercom] failed to construct NativeEventEmitter', e);
      return () => {};
    }
  } else {
    emitter = DeviceEventEmitter;
  }

  const subs: EmitterSubscription[] = [];

  let lastUnreadCount: number | null = null;
  subs.push(
    emitter.addListener(
      events.IntercomUnreadCountDidChange,
      (payload: { count?: number }) => {
        const count = payload?.count ?? 0;
        if (count === lastUnreadCount) return;
        lastUnreadCount = count;
        send({ type: 'intercomUnreadCountChanged', count });
      }
    )
  );
  subs.push(
    emitter.addListener(events.IntercomWindowDidShow, () => {
      send({ type: 'intercomWindowDidShow' });
    })
  );
  subs.push(
    emitter.addListener(events.IntercomWindowDidHide, () => {
      send({ type: 'intercomWindowDidHide' });
    })
  );

  return () => {
    for (const s of subs) s.remove();
  };
}
