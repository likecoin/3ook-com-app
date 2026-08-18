/**
 * MetaMask login button — fixed-position overlay shown below the WebView's
 * email login screen. Renders nothing when `visible` is false so this stays
 * a zero-cost component on most app routes.
 *
 * The actual flow lives in `services/wallet-auth-bridge` — this component
 * just wires the hook to a button and a small status/error row.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMetaMaskLogin, type MetaMaskLoginStatus } from '../services/wallet-auth-bridge';

interface Props {
  visible: boolean;
  onAuthenticated: () => void;
}

export function MetaMaskLoginButton({ visible, onAuthenticated }: Props) {
  const insets = useSafeAreaInsets();
  const { login, status, error } = useMetaMaskLogin({ onAuthenticated });

  if (!visible) return null;

  const busy = isBusy(status);

  return (
    <View
      style={[styles.container, { paddingBottom: Math.max(insets.bottom, 16) }]}
      pointerEvents="box-none"
    >
      {error ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorText} numberOfLines={3}>
            {error}
          </Text>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Login with MetaMask"
        disabled={busy}
        onPress={() => {
          login();
        }}
        style={({ pressed }) => [
          styles.button,
          busy && styles.buttonDisabled,
          pressed && !busy && styles.buttonPressed,
        ]}
      >
        {busy ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.buttonText}>{statusLabel(status)}</Text>
        )}
      </Pressable>
    </View>
  );
}

function isBusy(status: MetaMaskLoginStatus): boolean {
  return status === 'connecting' || status === 'signing' || status === 'authenticating';
}

function statusLabel(status: MetaMaskLoginStatus): string {
  switch (status) {
    case 'success':
      return 'Logged in';
    case 'error':
      return 'Try again with MetaMask';
    default:
      return 'Login with MetaMask';
  }
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 24,
    paddingTop: 8,
    backgroundColor: 'transparent',
  },
  button: {
    height: 52,
    borderRadius: 26,
    backgroundColor: '#F6851B', // MetaMask orange
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    elevation: 4,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  errorRow: {
    backgroundColor: '#FDECEA',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 8,
  },
  errorText: {
    color: '#B71C1C',
    fontSize: 13,
  },
});
