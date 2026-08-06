// Shared by driver.mjs (iOS Simulator) and driver-android.mjs (emulator).
// Everything platform-neutral lives here: paths, Metro, the URL-rejection
// predicate, and the smoke scenario both platforms run.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const SKILL_DIR = import.meta.dirname;
export const REPO = path.resolve(SKILL_DIR, '../../..');
export const ART = path.join(SKILL_DIR, '.artifacts');
export const SHOTS = path.join(ART, 'shots');
// One Metro serves both platforms, so both drivers share this log.
export const METRO_LOG = path.join(ART, 'metro.log');

// From app.config.ts `ios.bundleIdentifier` / `android.package`. Reading it for
// real would mean evaluating app.config.ts (TS + env + plugins) on every command.
export const APP_ID = 'land.liker.book3app';
// Where the WebView lands when nothing valid is persisted (url-storage.native.ts).
export const HOME_URL = 'https://3ook.com?app=1';
export const METRO_PORT = 8081;
// Cap on how long to wait for a cold start to settle before screenshotting.
export const SETTLE_CAP_MS = 14000;

export { sleep };
export const log = (...a) => console.log(...a);
export function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// package.json has no `"type": "module"`, so Node reparses each .ts as ESM and
// warns. Harmless, and suppressible here because this import needs no loader
// hook — unlike probe.mjs, whose hook runs on a thread this filter can't reach.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.warn(w);
});

// The app's own host/path rules, imported rather than re-implemented: these
// drivers exist to verify that predicate, so a private copy could drift and
// still report a pass. external-hosts.ts has no imports, so Node loads it bare.
const { isBookstorePath, isExternalBrowserHost } = await import(
  pathToFileURL(path.join(REPO, 'services/external-hosts.ts')).href
);

/**
 * Resolve a `goto` target to the URL to seed, and say whether the app will
 * actually keep it. Mirrors is3ookURL + ensureAppParam in url-storage.native.ts.
 */
export function normalizeTarget(target) {
  const raw = /^https?:\/\//i.test(target)
    ? target
    : `https://3ook.com${target.startsWith('/') ? '' : '/'}${target}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    die(`not a URL: ${target}`);
  }
  const host = parsed.hostname.toLowerCase();
  const rejected =
    parsed.protocol !== 'https:' ||
    !(host === '3ook.com' || host.endsWith('.3ook.com')) ||
    isBookstorePath(parsed.pathname) ||
    isExternalBrowserHost(host);
  parsed.searchParams.set('app', '1');
  return { url: parsed.toString(), rejected };
}

// --- metro -----------------------------------------------------------------

export const metroUp = () =>
  fetch(`http://127.0.0.1:${METRO_PORT}/status`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);

export async function ensureMetro() {
  if (await metroUp()) {
    log('metro: already running on :8081');
    return;
  }
  mkdirSync(ART, { recursive: true });
  // Hand Metro the log file descriptor directly. A pipe through this process
  // keeps its event loop alive, so the command would never return. Truncating
  // on a fresh start is what keeps this file from growing without bound.
  const fd = openSync(METRO_LOG, 'w');
  spawn('npx', ['expo', 'start', '--port', String(METRO_PORT)], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', fd, fd],
  }).unref();
  for (let i = 0; i < 240; i++) {
    if (await metroUp()) {
      log(`metro: up (log → ${path.relative(REPO, METRO_LOG)})`);
      return;
    }
    await sleep(250);
  }
  die(`metro did not come up within 60s — see ${METRO_LOG}`);
}

// --- smoke -----------------------------------------------------------------

// One step per URL-restore rule in url-storage.native.ts: a normal route is
// restored; a browser-only subdomain and a bookstore path are not.
export const SMOKE_STEPS = [
  {
    target: '/en/shelf',
    shot: '1-shelf',
    label: 'restores a seeded URL',
    ok: (url) => url.includes('/shelf'),
  },
  {
    target: 'https://docs.3ook.com/getting-started',
    shot: '2-docs-fallback',
    label: 'docs subdomain is not restored in-app',
    ok: (url) => !/docs\./.test(url),
  },
  {
    target: '/store',
    shot: '3-store-fallback',
    label: 'store URL is not restored in-app',
    ok: (url) => !/\/store/.test(url),
  },
];

// RevenueCat logs an error whenever logOut runs with nobody signed in, which is
// every launch on a fresh device. Wording differs per platform.
export const BENIGN_COMMON = [/log ?out\b.*anonymous/i];

/**
 * Wait for the WebView to reach a URL and hold it. app/index.tsx debounces
 * saveLastURL 1.5s after the last navigation, so a newer timestamp in the
 * persisted-URL store means the page settled — far tighter than a fixed sleep.
 * Falls back to the cap if the app never writes (e.g. it crashed).
 */
export async function waitForSettle(readPersisted, seededAt) {
  const deadline = Date.now() + SETTLE_CAP_MS;
  while (Date.now() < deadline) {
    if ((readPersisted()?.timestamp ?? 0) > seededAt) {
      await sleep(500);
      return true;
    }
    await sleep(250);
  }
  return false;
}

/** Drive SMOKE_STEPS through platform-supplied primitives. */
export async function runSmokeSteps({ goto, shot, readPersisted, prefix }) {
  const checks = [];
  for (const step of SMOKE_STEPS) {
    const seededAt = goto(step.target);
    if (!(await waitForSettle(readPersisted, seededAt))) {
      log(`  (no navigation settled within ${SETTLE_CAP_MS / 1000}s — screenshotting anyway)`);
    }
    await shot(`${prefix}-${step.shot}`);
    checks.push([step.label, step.ok(readPersisted()?.url ?? '')]);
  }
  return checks;
}

export function reportSmoke({ running, checks, persistedURL, errors, extra = [] }) {
  log('\n--- smoke summary ---');
  log(`app running:      ${running ? 'yes' : 'NO'}`);
  for (const [label, ok] of checks) log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  log(`persisted URL:    ${persistedURL}`);
  log(`JS errors:        ${errors.length}`);
  errors.slice(0, 10).forEach((e) => log('  ' + e.trim()));
  log(`screenshots:      ${SHOTS}`);
  for (const line of extra) log(line);
  // Set exitCode rather than exiting: process.exit can truncate stdout when
  // it's a pipe, which is every agent invocation.
  if (!running || errors.length || checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

// --- cli -------------------------------------------------------------------

export function screenshotPath(name) {
  mkdirSync(SHOTS, { recursive: true });
  return path.join(SHOTS, `${name}.png`);
}

/** Print at most `lines` trailing lines, noting anything suppressed. */
export function tail(text, lines) {
  const all = text.split('\n');
  if (all.length <= lines) return text;
  return `… ${all.length - lines} earlier lines suppressed …\n` + all.slice(-lines).join('\n');
}

export function unknownCommand(cmd, help) {
  console.error(`unknown command: ${cmd}\n\n${help}`);
  process.exit(2);
}

export const artifactsExist = () => existsSync(ART);
