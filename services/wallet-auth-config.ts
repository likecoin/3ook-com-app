/**
 * Reown AppKit (WalletConnect v2) configuration for the 3ook app.
 *
 * `createAppKit()` is a singleton — call this exactly once near boot.
 * Wallet support: any WalletConnect-compatible mobile wallet (MetaMask,
 * Rainbow, Trust, etc.) — we surface MetaMask first via `featuredWalletIds`.
 */
import '@walletconnect/react-native-compat';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAppKit, type AppKitConfig } from '@reown/appkit-react-native';
import { EthersAdapter } from '@reown/appkit-ethers-react-native';
import type { Storage } from '@reown/appkit-common-react-native';

type AppKitInstance = ReturnType<typeof createAppKit>;

// ──────────────────────────────────────────────────────────────────────────
// Project ID — get one from https://cloud.reown.com (free signup).
// Override via app.config.ts `extra.reownProjectId` (we read via Constants
// later if needed). For now read from an EXPO_PUBLIC env var so any team
// member can run a build without code changes.
//
// ⚠️ The placeholder below WILL throw at WalletConnect handshake time.
// Set EXPO_PUBLIC_REOWN_PROJECT_ID before running a real build.
// ──────────────────────────────────────────────────────────────────────────
const PROJECT_ID =
  process.env.EXPO_PUBLIC_REOWN_PROJECT_ID ?? 'REPLACE_WITH_REOWN_PROJECT_ID';

const metadata: AppKitConfig['metadata'] = {
  name: '3ook.com',
  description: '3ook.com — decentralized digital bookstore',
  url: 'https://3ook.com',
  icons: ['https://3ook.com/icon.png'],
  redirect: {
    // Match `scheme: 'com.3ook'` in app.config.ts so wallet apps can come
    // back to us via universal/deep link.
    native: 'com.3ook://',
    universal: 'https://3ook.com',
  },
};

// Networks the user can sign on. 3ook books are NFTs on Base (and the api
// docs mention Ethereum mainnet for some legacy paths). Keep both so the
// wallet doesn't refuse to connect on a wrong-chain technicality — the
// /users/login endpoint only verifies the signature, not the chain.
const ethereum = {
  id: 1,
  name: 'Ethereum',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://cloudflare-eth.com'] } },
  chainNamespace: 'eip155' as const,
  caipNetworkId: 'eip155:1' as const,
};

const base = {
  id: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://mainnet.base.org'] } },
  chainNamespace: 'eip155' as const,
  caipNetworkId: 'eip155:8453' as const,
};

// MetaMask wallet ID from the WalletConnect Explorer.
const METAMASK_WALLET_ID = 'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96';

// Thin AsyncStorage→Reown Storage shim.
const storage: Storage = {
  async getKeys() {
    return (await AsyncStorage.getAllKeys()) as string[];
  },
  async getEntries<T = any>() {
    const keys = (await AsyncStorage.getAllKeys()) as string[];
    const pairs = await AsyncStorage.multiGet(keys);
    return pairs.map(([k, v]) => [k, v == null ? undefined : safeParse<T>(v)] as [string, T]);
  },
  async getItem<T = any>(key: string) {
    const raw = await AsyncStorage.getItem(key);
    return raw == null ? undefined : safeParse<T>(raw);
  },
  async setItem<T = any>(key: string, value: T) {
    await AsyncStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  },
  async removeItem(key: string) {
    await AsyncStorage.removeItem(key);
  },
};

function safeParse<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

let appKitInstance: AppKitInstance | null = null;

export function initWalletAuth(): AppKitInstance {
  if (appKitInstance) return appKitInstance;
  appKitInstance = createAppKit({
    projectId: PROJECT_ID,
    metadata,
    adapters: [new EthersAdapter()],
    networks: [ethereum, base],
    defaultNetwork: ethereum,
    storage,
    featuredWalletIds: [METAMASK_WALLET_ID],
    themeMode: 'light',
    debug: __DEV__,
  });
  return appKitInstance;
}

export function getAppKitInstance(): AppKitInstance | null {
  return appKitInstance;
}

export function hasValidReownProjectId(): boolean {
  return PROJECT_ID !== 'REPLACE_WITH_REOWN_PROJECT_ID' && PROJECT_ID.length > 0;
}
