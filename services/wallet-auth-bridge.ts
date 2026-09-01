/**
 * useMetaMaskLogin — orchestrates the native MetaMask sign-in flow against
 * 3ook.com's own `/api/login` endpoint (NOT api.like.co directly; see the
 * comment in `likecoin-auth-api.ts` for why).
 *
 * Flow:
 *   1. Open Reown AppKit modal → user picks/connects MetaMask
 *   2. Build & personal_sign the authorize payload (must match the web's
 *      JWT_PERMISSIONS + pretty-printed JSON byte-for-byte)
 *   3. POST 3ook.com/api/login → Set-Cookie: nuxt-session=…
 *   4. Re-issue that cookie into the WebView's cookie store so the next
 *      navigation includes it.
 *
 * Designed for the "Case C" minimum: only existing wallet-registered
 * users. If `/api/login` returns 401/4xx we surface the server's message
 * so the UI can tell the user to register on the web first.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import CookieManager from '@preeternal/react-native-cookie-manager';
import {
  useAppKit,
  useAppKitState,
  useAccount,
  useProvider,
} from '@reown/appkit-react-native';
import { StorageUtil } from '@reown/appkit-core-react-native';
import { getAddress } from 'ethers';

import {
  buildAuthorizePayload,
  loginTo3ook,
  ThreeOokAuthError,
} from './likecoin-auth-api';
import { hasValidReownProjectId } from './wallet-auth-config';

export type MetaMaskLoginStatus =
  | 'idle'
  | 'connecting'
  | 'signing'
  | 'authenticating'
  | 'success'
  | 'error';

export interface UseMetaMaskLoginResult {
  status: MetaMaskLoginStatus;
  error: string | null;
  address: string | undefined;
  isConnected: boolean;
  login: () => Promise<boolean>;
  reset: () => void;
}

interface UseMetaMaskLoginOptions {
  /** Called after cookie injection so the host can reload the WebView. */
  onAuthenticated: () => void;
}

export function useMetaMaskLogin(opts: UseMetaMaskLoginOptions): UseMetaMaskLoginResult {
  const { open, disconnect } = useAppKit();
  const { isOpen } = useAppKitState();
  const account = useAccount();
  const { provider } = useProvider();

  const [status, setStatus] = useState<MetaMaskLoginStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const accountRef = useRef({
    address: account.address,
    isConnected: account.isConnected,
  });
  const providerRef = useRef(provider);
  const isOpenRef = useRef(isOpen);
  const onAuthenticatedRef = useRef(opts.onAuthenticated);
  useEffect(() => {
    accountRef.current = { address: account.address, isConnected: account.isConnected };
  }, [account.address, account.isConnected]);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);
  useEffect(() => {
    onAuthenticatedRef.current = opts.onAuthenticated;
  }, [opts.onAuthenticated]);

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
  }, []);

  const login = useCallback(async (): Promise<boolean> => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setError(null);

    try {
      if (!hasValidReownProjectId()) {
        throw new Error(
          'Wallet login is not configured on this build. Set EXPO_PUBLIC_REOWN_PROJECT_ID.'
        );
      }

      // Restored WalletConnect sessions look connected but the wallet app is
      // not in the foreground; personal_sign then waits forever. Always pair
      // fresh so the connect deep link is established before we ask to sign.
      if (accountRef.current.isConnected) {
        console.warn('[wallet-auth] disconnecting restored session');
        disconnect();
        await waitUntil(() => !accountRef.current.isConnected, 8_000);
      }

      setStatus('connecting');
      console.warn('[wallet-auth] connecting');
      open();
      await waitForWalletConnection({
        isConnected: () =>
          accountRef.current.isConnected && !!accountRef.current.address,
        isModalOpen: () => isOpenRef.current,
      });
      await waitUntil(() => !!providerRef.current, 10_000);

      const rawAddress = accountRef.current.address;
      if (!rawAddress) throw new Error('Wallet connection cancelled');

      // 2) Build the authorize message and sign with EIP-191 personal_sign.
      setStatus('signing');
      const checksummed = getAddress(rawAddress);
      const { message } = buildAuthorizePayload({
        checksummedAddress: checksummed,
        loginMethod: 'metaMask',
      });

      const eip1193 = providerRef.current;
      if (!eip1193) throw new Error('Wallet provider unavailable');

      console.warn('[wallet-auth] signing');
      const signPromise = withTimeout(
        eip1193.request({
          method: 'personal_sign',
          params: [message, checksummed],
        }),
        120_000,
        'Wallet signature timed out'
      );
      // WC does not reopen the wallet for a follow-up request; bounce back
      // via the native scheme stored during connect (e.g. metamask://).
      await reopenConnectedWallet();
      const signature = (await signPromise) as string;

      // 3) POST to 3ook.com/api/login — server validates the signature
      // against api.like.co/wallet/authorize and mints a nuxt-session.
      setStatus('authenticating');
      console.warn('[wallet-auth] authenticating');
      const { setCookieHeader, userInfo } = await loginTo3ook({
        walletAddress: checksummed,
        message,
        signature,
        loginMethod: 'metaMask',
      });

      if (__DEV__) {
        console.log('[wallet-auth] /api/login OK, user:', userInfo?.likerId ?? userInfo?.user);
      }

      // 4) Install the nuxt-session cookie into the WebView's jar so the
      // next page load includes it.
      await persistNuxtSession({ setCookieHeader });

      setStatus('success');
      console.warn('[wallet-auth] success');
      onAuthenticatedRef.current?.();
      return true;
    } catch (e) {
      console.warn('[wallet-auth] failed', formatError(e));
      setError(formatError(e));
      setStatus('error');
      return false;
    } finally {
      inFlightRef.current = false;
    }
  }, [open, disconnect]);

  return {
    status,
    error,
    address: account.address,
    isConnected: account.isConnected,
    login,
    reset,
  };
}

async function reopenConnectedWallet() {
  const deepLink = await StorageUtil.getWalletConnectDeepLink();
  const href = deepLink?.href;
  if (!href) {
    console.warn('[wallet-auth] signing no wallet deep link');
    return;
  }
  console.warn('[wallet-auth] signing reopen wallet');
  try {
    await Linking.openURL(href);
  } catch {
    console.warn('[wallet-auth] signing reopen wallet failed');
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(200);
  }
}

async function waitForWalletConnection(args: {
  isConnected: () => boolean;
  isModalOpen: () => boolean;
  timeoutMs?: number;
  stepMs?: number;
}) {
  const { isConnected, isModalOpen, timeoutMs = 120_000, stepMs = 250 } = args;
  const start = Date.now();
  let sawOpen = false;
  let cancelAt: number | null = null;
  while (Date.now() - start < timeoutMs) {
    if (isConnected()) return;
    if (isModalOpen()) {
      sawOpen = true;
      cancelAt = null;
    } else if (sawOpen && AppState.currentState === 'active') {
      // Modal closed while we are still in the foreground — likely dismiss.
      // Grace period covers returning from MetaMask before the session lands.
      if (cancelAt == null) cancelAt = Date.now() + 15_000;
      if (Date.now() >= cancelAt) {
        throw new Error('Wallet connection cancelled');
      }
    } else {
      cancelAt = null;
    }
    await sleep(stepMs);
  }
  throw new Error('Wallet connection timed out');
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Install the server's Set-Cookie verbatim onto 3ook.com (and a few
 * sibling hosts as a safety net) so the WebView's HTTP layer sends it
 * on the next request.
 */
async function persistNuxtSession(args: { setCookieHeader: string | null }) {
  const { setCookieHeader } = args;
  if (!setCookieHeader) {
    throw new Error('Server did not return a session cookie');
  }

  // setFromResponse parses the raw Set-Cookie header (including HttpOnly,
  // SameSite, Domain, etc.) so we preserve every attribute the server
  // wanted. We hit the 3ook.com URL because nuxt-session is scoped to
  // 3ook.com; the bare-host call is what Android needs to apply it.
  const urls = ['https://3ook.com', 'https://www.3ook.com'];
  const failures: string[] = [];
  for (const url of urls) {
    try {
      await CookieManager.setFromResponse(url, setCookieHeader);
    } catch (e) {
      console.warn(`[wallet-auth] setFromResponse(${url}) failed`, e);
      failures.push(url);
    }
  }

  if (failures.includes('https://3ook.com')) {
    throw new Error('Logged in but failed to persist session locally');
  }

  try {
    await CookieManager.flush();
  } catch (e) {
    console.warn('[wallet-auth] CookieManager.flush failed', e);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function formatError(e: unknown): string {
  if (e instanceof ThreeOokAuthError) {
    if (e.status === 401 || e.status === 403) {
      return 'This wallet is not linked to a 3ook account. Please register on the website first.';
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
