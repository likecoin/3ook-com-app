#!/usr/bin/env node
// Android emulator driver for the 3ook.com app. Same command vocabulary as
// driver.mjs (the iOS one) so you don't have to relearn it.
//
//   node .claude/skills/run-3ook-com-app/driver-android.mjs <command> [args]
//
// Unlike iOS, Android *can* be driven with real App Link intents — see `link`.

import { spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  APP_ID, HOME_URL, REPO,
  BENIGN_COMMON, die, ensureMetro, log, normalizeTarget, reportSmoke,
  runSmokeSteps, screenshotPath, sleep, tail, unknownCommand,
} from './driver-common.mjs';

const ACTIVITY = `${APP_ID}/.MainActivity`;
const URL_STORE = 'files/last-url.json';

const SDK = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  ?? path.join(os.homedir(), 'Library/Android/sdk');
const ADB = path.join(SDK, 'platform-tools/adb');
// SDK layouts vary — the emulator package is not always under emulator/.
const EMULATOR = ['emulator/emulator', 'emulator_old/emulator', 'tools/emulator']
  .map((p) => path.join(SDK, p)).find(existsSync);

const adb = (args, opts = {}) =>
  spawnSync(ADB, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, ...opts });
const adbOut = (args) => (adb(args).stdout ?? '').trim();
/** Single-quote for the device shell — `adb shell` re-splits its argv, so an
 *  unquoted `&` in a URL truncates the command. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// --- device ----------------------------------------------------------------

function device() {
  // A cold adb daemon reports an empty device list on its first call, which
  // reads as "no emulator" and makes `boot` start a second one. Ask twice.
  for (let i = 0; i < 2; i++) {
    const line = adbOut(['devices']).split('\n').slice(1).find((l) => /\tdevice$/.test(l));
    if (line) return line.split('\t')[0];
    adb(['start-server']);
  }
  return null;
}

function requireDevice() {
  return device() ?? die('no Android device/emulator — run: driver-android.mjs boot');
}

async function boot(avdName) {
  const connected = device();
  if (connected) { log(`already connected: ${connected}`); return connected; }
  if (!EMULATOR) die(`no emulator binary under ${SDK}`);
  const avds = (spawnSync(EMULATOR, ['-list-avds'], { encoding: 'utf8' }).stdout ?? '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const avd = avdName ?? avds[0];
  if (!avd) die('no AVDs defined — create one in Android Studio');
  spawn(EMULATOR, ['-avd', avd, '-no-snapshot-load', '-no-boot-anim'],
    { detached: true, stdio: 'ignore' }).unref();
  log(`starting emulator ${avd} …`);
  adb(['wait-for-device'], { timeout: 180_000 });
  for (let i = 0; i < 120; i++) {
    if (adbOut(['shell', 'getprop', 'sys.boot_completed']) === '1') {
      const d = device();
      log(`booted: ${d}`);
      return d;
    }
    await sleep(2000);
  }
  die('emulator did not finish booting within 240s');
}

const isInstalled = () => adbOut(['shell', 'pm', 'list', 'packages', APP_ID]).includes(APP_ID);
const isRunning = () => adbOut(['shell', 'pidof', APP_ID]).length > 0;

function readPersisted() {
  const r = adb(['shell', `run-as ${APP_ID} cat ${URL_STORE}`]);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// --- app lifecycle ---------------------------------------------------------

async function build() {
  await boot();
  await ensureMetro();
  log('$ npx expo run:android');
  if (spawnSync('npx', ['expo', 'run:android'], { cwd: REPO, stdio: 'inherit' }).status !== 0) {
    die('build failed');
  }
}

const launch = () => { adb(['shell', 'am', 'start', '-n', ACTIVITY]); log('launched'); };
const stop = () => { adb(['shell', 'am', 'force-stop', APP_ID]); log('stopped'); };
const relaunch = () => { stop(); launch(); };

/**
 * Point the WebView at a URL by seeding the app's persisted-URL store, the same
 * primitive the iOS driver uses. `run-as` needs a debuggable (Debug) build.
 * Returns the timestamp written.
 */
function goto(target) {
  requireDevice();
  const { url, rejected } = normalizeTarget(target);
  const timestamp = Date.now();
  const payload = JSON.stringify({ url, timestamp });
  stop();
  // Base64 so the JSON's quotes survive both the host and device shells.
  const b64 = Buffer.from(payload).toString('base64');
  adb(['shell', `echo ${b64} | base64 -d | run-as ${APP_ID} sh -c 'cat > ${URL_STORE}'`]);
  if (readPersisted()?.timestamp !== timestamp) {
    die(`could not write ${URL_STORE} — run-as needs a Debug build (is a Release APK installed?)`);
  }
  log(`seeded last-url.json → ${url}${rejected ? `  (app will fall back to ${HOME_URL})` : ''}`);
  launch();
  return timestamp;
}

/** Real App Link intent. Works on Android (unlike `simctl openurl` on iOS). */
function link(url) {
  requireDevice();
  const r = adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', shq(url), APP_ID]);
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
  // `am start` reports "Error: ..." on stdout and still exits 0.
  if (/^Error/m.test(out)) die(`am start failed: ${out}`);
  log(out);
}

function showState() {
  requireDevice();
  const r = adb(['shell', `run-as ${APP_ID} ls files`]);
  if (r.status !== 0 || /run-as|error/i.test(r.stderr ?? '')) {
    die(`run-as failed (${(r.stderr || r.stdout).trim()}) — needs a Debug build`);
  }
  for (const f of r.stdout.split('\n').map((s) => s.trim()).filter((f) => f.endsWith('.json'))) {
    if (f.startsWith('.posthog')) { log(`--- ${f} --- (PostHog SDK store, elided)`); continue; }
    log(`--- ${f} ---`);
    log(adbOut(['shell', `run-as ${APP_ID} cat files/${f}`]));
  }
}

// --- observation -----------------------------------------------------------

async function shot(name = 'android') {
  requireDevice();
  const out = screenshotPath(name);
  const r = adb(['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
  if (r.status !== 0 || !r.stdout?.length) die('screencap returned nothing');
  writeFileSync(out, r.stdout);
  log(out);
  return out;
}

// React Native's JS console lands on the ReactNativeJS logcat tag. Pin the
// format: threadtime puts the level before the tag, which is what ERROR_LINE
// keys on — the default format differs by platform-tools version.
const jsLogcat = (extra = []) => adbOut([
  'logcat', '-v', 'threadtime', ...extra,
  '-s', 'ReactNativeJS:V', 'ReactNative:E', 'AndroidRuntime:E',
]);
// "<date> <time> <pid> <tid> <level> <tag>: message"
const ERROR_LINE = /^\S+ \S+ +\d+ +\d+ [EF] /;

function logs(lines = 60) {
  requireDevice();
  log(tail(jsLogcat(['-d']), lines));
}

// --- composite -------------------------------------------------------------

// Play Billing reports unavailable on the emulator (even a playstore system
// image has no signed-in Google account), so RevenueCat floods logcat.
const BENIGN = [...BENIGN_COMMON, /BILLING_UNAVAILABLE|Billing is not available in this device/];

async function smoke() {
  // Emulators shut themselves down (memory pressure, long idles). Re-boot
  // rather than failing the run; the app survives a shutdown.
  await boot();
  if (!isInstalled()) die('app not installed — run: driver-android.mjs build');
  adb(['logcat', '-c']);

  const checks = await runSmokeSteps({ goto, shot, readPersisted, prefix: 'android' });

  const errors = jsLogcat(['-d']).split('\n')
    .filter((l) => ERROR_LINE.test(l))
    .filter((l) => !BENIGN.some((re) => re.test(l)));
  reportSmoke({
    running: isRunning(),
    checks,
    persistedURL: readPersisted()?.url ?? '(none)',
    errors,
  });
}

function doctor() {
  const d = device();
  const rows = [
    ['node', process.version],
    ['sdk', SDK + (existsSync(SDK) ? '' : ' — MISSING')],
    ['adb', existsSync(ADB) ? adbOut(['version']).split('\n')[0] : 'MISSING'],
    ['emulator', EMULATOR ?? 'MISSING'],
    ['device', d ?? '(none)'],
    ['app installed', d ? (isInstalled() ? 'yes' : 'no') : 'n/a'],
    ['app running', d ? (isRunning() ? 'yes' : 'no') : 'n/a'],
    ['android/ prebuilt', existsSync(path.join(REPO, 'android', 'gradlew')) ? 'yes' : 'no — run npx expo prebuild'],
  ];
  for (const [k, v] of rows) log(`${k.padEnd(18)} ${v}`);
}

// --- cli -------------------------------------------------------------------

const HELP = `
usage: node .claude/skills/run-3ook-com-app/driver-android.mjs <command>

  doctor              sdk / adb / emulator / install state
  boot [avd]          start an emulator and wait for boot_completed
  build               npx expo run:android — compiles, installs, launches
  metro               start Metro detached, logging to .artifacts/metro.log
  launch|stop|relaunch
  goto <url|path>     point the WebView at a URL (seeds last-url.json, relaunches)
  link <url>          fire a real VIEW intent (App Link path — Android only)
  state               dump the app's files/*.json
  shot [name]         screenshot → .artifacts/shots/<name>.png
  logs [n]            last n lines of ReactNativeJS logcat
  smoke               drive three routes, screenshot each, assert no JS errors
`.trim();

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'doctor': doctor(); break;
  case 'boot': await boot(rest[0]); break;
  case 'build': await build(); break;
  case 'metro': await ensureMetro(); break;
  case 'launch': requireDevice(); launch(); break;
  case 'stop': requireDevice(); stop(); break;
  case 'relaunch': requireDevice(); relaunch(); break;
  case 'goto': goto(rest[0] ?? '/'); break;
  case 'link': link(rest[0] ?? HOME_URL); break;
  case 'state': showState(); break;
  case 'shot': await shot(rest[0]); break;
  case 'logs': logs(Number(rest[0]) || 60); break;
  case 'smoke': await smoke(); break;
  case undefined: case 'help': case '-h': case '--help': log(HELP); break;
  default: unknownCommand(cmd, HELP);
}
