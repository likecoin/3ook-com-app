import * as Sentry from '@sentry/react-native';
import analytics from '@react-native-firebase/analytics';
import type PostHog from 'posthog-react-native';
import type { BridgeHandlerMap } from './bridge-dispatcher';

export function getIdentityHandlers(posthog: PostHog): BridgeHandlerMap {
  return {
    identifyUser: async (msg) => {
      const userId = typeof msg.userId === 'string' ? msg.userId : undefined;
      if (!userId) return;

      // Firebase Analytics needs the SHA-256 wallet that the web also
      // feeds to gtag, so GA4's no-PII rule is honoured and app + web
      // sessions stitch under the same User-ID. If an older web build
      // omits it, skip setUserId rather than forward the raw wallet.
      const gaUserId =
        typeof msg.gaUserId === 'string' ? msg.gaUserId : undefined;

      const email = typeof msg.email === 'string' ? msg.email : undefined;
      const displayName =
        typeof msg.displayName === 'string' ? msg.displayName : undefined;
      const isLikerPlus = !!msg.isLikerPlus;
      const loginMethod =
        typeof msg.loginMethod === 'string' ? msg.loginMethod : undefined;
      const locale = typeof msg.locale === 'string' ? msg.locale : undefined;

      posthog.identify(userId, {
        email: email ?? null,
        name: displayName ?? null,
        is_liker_plus: isLikerPlus,
        login_method: loginMethod ?? null,
        locale: locale ?? null,
      });

      const fa = analytics();
      const faTasks: Promise<void>[] = [
        fa.setUserProperties({
          is_liker_plus: String(isLikerPlus),
          login_method: loginMethod ?? '',
          locale: locale ?? '',
        }),
      ];
      if (gaUserId) faTasks.push(fa.setUserId(gaUserId));
      await Promise.all(faTasks);

      Sentry.setUser({
        id: userId,
        email,
        username: displayName || userId,
      });
    },

    resetUser: async () => {
      posthog.reset();
      await analytics().setUserId(null);
      Sentry.setUser(null);
    },
  };
}
