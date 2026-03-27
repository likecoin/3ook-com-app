import { useEffect, useRef, useCallback } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';

import packageJson from '../package.json';
import { registerHandlers, dispatch } from '../services/bridge-dispatcher';
import {
  setupPlayer,
  getAudioHandlers,
  registerEventListeners,
} from '../services/audio-bridge';
import { getIdentityHandlers } from '../services/identity-bridge';
import { getURLHandlers } from '../services/url-bridge';
import { posthog } from '../services/posthog';

export default function App() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);

  const sendToWebView = useCallback((data: object) => {
    const json = JSON.stringify(data);
    webViewRef.current?.injectJavaScript(
      `window.dispatchEvent(new CustomEvent('nativeAudioEvent',{detail:${json}}));` +
        `window.dispatchEvent(new CustomEvent('nativeBridgeEvent',{detail:${json}}));true;`
    );
  }, []);

  useEffect(() => {
    registerHandlers(getAudioHandlers());
    registerHandlers(getIdentityHandlers(posthog));
    registerHandlers(getURLHandlers());

    setupPlayer();
    const unsubscribe = registerEventListeners(sendToWebView);
    return unsubscribe;
  }, [sendToWebView]);

  // Reload WebView when iOS kills its content process in the background.
  const handleContentProcessDidTerminate = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      try {
        await dispatch(event.nativeEvent.data, sendToWebView);
      } catch (e) {
        console.warn('[onMessage]', e);
      }
    },
    [sendToWebView]
  );

  return (
    <>
      <View style={{ ...styles.topSpacer, height: insets.top }} />
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          source={{ uri: 'https://3ook.com?app=1' }}
          originWhitelist={['*']}
          style={styles.webview}
          userAgent={`3ook-com-app/${packageJson.version} (${Platform.OS} ${Platform.Version})`}
          sharedCookiesEnabled={true}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback={true}
          pullToRefreshEnabled={true}
          onMessage={handleMessage}
          onContentProcessDidTerminate={handleContentProcessDidTerminate}
          onError={(e) => console.warn('[WebView error]', e.nativeEvent)}
          onHttpError={(e) => console.warn('[WebView HTTP error]', e.nativeEvent)}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  topSpacer: {
    backgroundColor: '#131313',
  },
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  webview: {
    flex: 1,
  },
});
