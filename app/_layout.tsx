// Polyfills required by Reown AppKit (WalletConnect v2) must run before any
// crypto-using import. Order matters — keep these two at the top.
import 'react-native-get-random-values';
import '@walletconnect/react-native-compat';

import * as Sentry from "@sentry/react-native";
import { Slot } from "expo-router";
import { PostHogProvider } from "posthog-react-native";
import { AppKit, AppKitProvider } from '@reown/appkit-react-native';

import { posthog } from "../services/posthog";
import { initWalletAuth } from "../services/wallet-auth-config";

// Singleton — safe to call repeatedly (guarded inside). Done at module load
// so the AppKit instance is ready before <AppKitProvider/> mounts below.
const appKit = initWalletAuth();

Sentry.init({
  dsn: "https://316d95879bd0e47063df647af48ceb1f@o149940.ingest.us.sentry.io/4510799071608832",

  // Adds more context data to events (IP address, cookies, user, etc.)
  // For more information, visit: https://docs.sentry.io/platforms/react-native/data-management/data-collected/
  sendDefaultPii: true,

  // Enable Logs
  enableLogs: false,

  // uncomment the line below to enable Spotlight (https://spotlightjs.com)
  // spotlight: __DEV__,
});

export default function RootLayout() {
  return (
    <AppKitProvider instance={appKit}>
      <PostHogProvider client={posthog}>
        <Slot />
        {/* AppKit modal: rendered once at the root so it overlays the WebView
            regardless of current route. Must live inside AppKitProvider. */}
        <AppKit />
      </PostHogProvider>
    </AppKitProvider>
  );
}
