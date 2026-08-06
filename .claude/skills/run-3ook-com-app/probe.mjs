#!/usr/bin/env node
// Direct-invocation harness: import and call this repo's TypeScript service /
// hook logic in bare Node, with no simulator, no Metro, and no build.
//
// Node 24 strips TS types natively, so `services/*.ts` imports as-is. What it
// can't do is resolve `react-native` / `expo-*` — those are native modules with
// no Node entry point. A resolve hook swaps them for the data-URL stubs below.
//
//   node .claude/skills/run-3ook-com-app/probe.mjs check
//   node .claude/skills/run-3ook-com-app/probe.mjs -e "const m = await load('services/external-hosts.ts'); console.log(m.isBookstoreURL('https://3ook.com/en/store'))"
//   node .claude/skills/run-3ook-com-app/probe.mjs run scratch/my-probe.mjs
//
// Add a stub below when a module you want to probe imports something new.

import { Buffer } from 'node:buffer';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../../..');

// package.json has no `"type": "module"`, so Node warns once per .ts file it
// reparses as ESM — on the loader thread, where a `warning` listener can't
// reach it. Only the CLI flag silences it, so re-exec ourselves with it once.
const QUIET = '--no-warnings=MODULE_TYPELESS_PACKAGE_JSON';
if (!process.execArgv.includes(QUIET)) {
  const { status } = spawnSync(process.execPath, [QUIET, ...process.argv.slice(1)], {
    stdio: 'inherit',
  });
  process.exit(status ?? 1);
}

// ---------------------------------------------------------------------------
// Stubs for native-only packages. Keep them minimal — just enough shape for the
// pure logic under test. Named exports must be declared statically here; ESM
// link-time checking means a Proxy can't stand in for an unknown export.
// ---------------------------------------------------------------------------
const STUBS = {
  'react-native': `
    export const Platform = { OS: globalThis.__PROBE_OS__ ?? 'ios', Version: '26.0', select: (o) => o[Platform.OS] ?? o.default };
    export const NativeModules = {};
    export const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
    export const BackHandler = { addEventListener: () => ({ remove() {} }) };
    export const Linking = { openURL: async (u) => { globalThis.__PROBE_OPENED__?.push(u); } };
    export const DeviceEventEmitter = { addListener: () => ({ remove() {} }) };
    export const StyleSheet = { create: (s) => s };
    export const View = 'View';
  `,
  'expo-file-system': `
    const mem = globalThis.__PROBE_FS__ ??= new Map();
    export const Paths = { document: '/probe/documents', cache: '/probe/cache' };
    export class File {
      constructor(dir, name) { this.uri = name ? dir + '/' + name : dir; }
      get exists() { return mem.has(this.uri); }
      write(data) { mem.set(this.uri, String(data)); }
      async text() { if (!mem.has(this.uri)) throw new Error('ENOENT ' + this.uri); return mem.get(this.uri); }
      textSync() { if (!mem.has(this.uri)) throw new Error('ENOENT ' + this.uri); return mem.get(this.uri); }
      delete() { mem.delete(this.uri); }
      create() { if (!mem.has(this.uri)) mem.set(this.uri, ''); }
    }
    export class Directory {
      constructor(dir, name) { this.uri = name ? dir + '/' + name : dir; }
      get exists() { return true; }
      create() {}
      list() { return []; }
    }
  `,
  'expo-application': `
    export const nativeApplicationVersion = '1.3.0';
    export const nativeBuildVersion = '999';
    export const applicationId = 'land.liker.book3app';
    export async function getInstallationTimeAsync() { return new Date(0); }
  `,
  'expo-linking': `
    export async function getInitialURL() { return globalThis.__PROBE_INITIAL_URL__ ?? null; }
    export function addEventListener() { return { remove() {} }; }
    export async function openURL(u) { (globalThis.__PROBE_OPENED__ ??= []).push(u); }
    export function createURL(p) { return 'com.3ook://' + p; }
  `,
  'expo-web-browser': `
    export async function openBrowserAsync(u) { (globalThis.__PROBE_OPENED__ ??= []).push('customtab:' + u); }
    export const WebBrowserPresentationStyle = {};
  `,
  'expo-constants': `export default { expoConfig: { extra: { revenueCat: {} } } };`,
  'expo-device': `export const isDevice = true; export const modelName = 'iPhone 17';`,
  'expo-notifications': `
    export async function getPermissionsAsync() { return { status: 'undetermined', canAskAgain: true }; }
    export async function requestPermissionsAsync() { return { status: 'granted', canAskAgain: false }; }
    export async function getExpoPushTokenAsync() { return { data: 'ExponentPushToken[probe]' }; }
    export function addNotificationResponseReceivedListener() { return { remove() {} }; }
    export function setNotificationHandler() {}
  `,
  'expo-store-review': `
    export async function isAvailableAsync() { return true; }
    export async function requestReview() {}
  `,
  'expo-sharing': `
    export async function isAvailableAsync() { return true; }
    export async function shareAsync() {}
  `,
  '@react-native-community/netinfo': `
    export async function fetch() { return { isConnected: true, isInternetReachable: true }; }
    export function addEventListener() { return () => {}; }
    export default { fetch, addEventListener };
  `,
  '@sentry/react-native': `
    export function captureException(e) { (globalThis.__PROBE_SENTRY__ ??= []).push(e); }
    export function setUser() {}
    export function addBreadcrumb() {}
  `,
  'posthog-react-native': `
    export default class PostHog { capture() {} identify() {} reset() {} register() {} }
  `,
  'react-native-purchases': `
    export default {
      configure() {}, async logIn() { return {}; }, async logOut() { return {}; },
      async getOfferings() { return { current: null }; },
      async purchasePackage() { return {}; }, async restorePurchases() { return {}; },
      async showManageSubscriptions() {}, setAttributes() {},
      async enableAdServicesAttributionTokenCollection() {},
    };
    export const LOG_LEVEL = { DEBUG: 'DEBUG', INFO: 'INFO' };
    export const PURCHASES_ERROR_CODE = {};
  `,
  '@preeternal/react-native-cookie-manager': `export default { get: async () => ({}), getAll: async () => ({}) };`,
};
// Firebase + Intercom re-export the same default-object shape.
for (const spec of [
  '@react-native-firebase/analytics',
  '@react-native-firebase/crashlytics',
  '@react-native-firebase/app',
]) {
  STUBS[spec] = `export default () => ({
    logEvent: async () => {}, setUserId: async () => {}, setUserProperty: async () => {},
    log: () => {}, recordError: () => {}, setAttribute: async () => {},
  });`;
}
STUBS['@intercom/intercom-react-native'] = `
  export default { loginUserWithUserAttributes: async () => {}, logout: async () => {},
    setUserHash: async () => {}, updateUser: async () => {}, sendTokenToIntercom: async () => {} };
  export const Space = {}; export const Visibility = {};
`;

const stubURL = (src) => 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');

register(pathToFileURL(path.join(import.meta.dirname, 'probe-loader.mjs')), {
  parentURL: import.meta.url,
  data: Object.fromEntries(Object.entries(STUBS).map(([k, v]) => [k, stubURL(v)])),
});

// ---------------------------------------------------------------------------
// Globals the app's own code expects from the Metro/Hermes runtime.
// ---------------------------------------------------------------------------
globalThis.__DEV__ = true;
globalThis.__PROBE_OPENED__ = [];

/** Import a repo module by path relative to the repo root. */
globalThis.load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

// ---------------------------------------------------------------------------
// Built-in check: the URL / host routing decision table. This is the logic that
// decides WebView vs system browser vs OS handler, and it is what most changes
// in services/ actually move.
// ---------------------------------------------------------------------------
async function check() {
  const hosts = await load('services/external-hosts.ts');
  const bound = await load('services/app-bound-domains.js');
  const storage = await load('services/url-storage.native.ts');
  const urlBridge = await load('services/url-bridge.native.ts');
  const attribution = await load('services/attribution-keys.ts');

  const cases = [
    // [label, actual, expected]
    ['store path is bookstore', hosts.isBookstoreURL('https://3ook.com/store'), true],
    ['locale store path is bookstore', hosts.isBookstoreURL('https://3ook.com/zh-Hant/store/x'), true],
    ['reader path is not bookstore', hosts.isBookstoreURL('https://3ook.com/en/reader/1'), false],
    ['http store is not bookstore', hosts.isBookstoreURL('http://3ook.com/store'), false],
    ['foreign store is not bookstore', hosts.isBookstoreURL('https://evil.com/store'), false],
    ['docs subdomain is external', hosts.isExternalBrowserHost('docs.3ook.com'), true],
    ['publish subdomain is external', hosts.isExternalBrowserHost('publish.3ook.com'), true],
    ['apex is not external', hosts.isExternalBrowserHost('3ook.com'), false],
    ['3ook is app-bound', bound.isAppBoundHost('www.3ook.com'), true],
    ['random host is not app-bound', bound.isAppBoundHost('example.com'), false],
    ['deep link resolves + forces app=1', storage.resolveDeepLinkURL('https://3ook.com/en/reader/1'),
      'https://3ook.com/en/reader/1?app=1'],
    ['docs deep link rejected', storage.resolveDeepLinkURL('https://docs.3ook.com/x'), null],
    ['store deep link rejected (goes external)', storage.resolveDeepLinkURL('https://3ook.com/store'), null],
    ['wallet scheme is deep link', urlBridge.isDeepLink('wc:abc@2?relay=x'), true],
    ['https 3ook is not deep link', urlBridge.isDeepLink('https://3ook.com/'), false],
    ['metamask universal link is deep link', urlBridge.isDeepLink('https://metamask.app.link/x'), true],
    ['attribution drops __proto__', JSON.stringify(attribution.sanitizeAttribution(
      JSON.parse('{"utm_source":"apple_ads","__proto__":{"x":1},"utm_medium":42}'))),
      '{"utm_source":"apple_ads"}'],
  ];

  // Round-trip the persisted-URL store through the in-memory expo-file-system stub.
  storage.saveLastURL('https://3ook.com/en/shelf');
  cases.push(['saved URL is restored with app=1', await storage.getInitialURL(),
    'https://3ook.com/en/shelf?app=1']);
  storage.saveLastURL('https://docs.3ook.com/nope');
  cases.push(['external host never persisted', await storage.getInitialURL(),
    'https://3ook.com/en/shelf?app=1']);

  let failed = 0;
  for (const [label, actual, expected] of cases) {
    const ok = Object.is(actual, expected);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed) process.exit(1);
}

// ---------------------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'check' || cmd === undefined) {
  await check();
} else if (cmd === '-e') {
  const body = rest.join(' ');
  await new (Object.getPrototypeOf(async function () {}).constructor)(body)();
} else if (cmd === 'run') {
  const target = path.resolve(process.cwd(), rest[0]);
  readFileSync(target); // fail loudly if missing
  await import(pathToFileURL(target).href);
} else {
  console.error(`unknown command: ${cmd}\nusage: probe.mjs [check] | -e <code> | run <script.mjs>`);
  process.exit(2);
}
