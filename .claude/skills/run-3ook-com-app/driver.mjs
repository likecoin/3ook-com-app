#!/usr/bin/env node
// iOS Simulator driver for the 3ook.com app.
//
// The app is a full-screen WebView shell, so "driving" it means three things:
// pointing the WebView at a URL, watching what the native side logs, and
// screenshotting the result. There is no tap automation (see SKILL.md
// "Gotchas") — navigation goes through the app's own persisted-URL store.
//
//   node .claude/skills/run-3ook-com-app/driver.mjs <command> [args]
//
// Run `driver.mjs help` for the command list.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, openSync } from 'node:fs';
import path from 'node:path';

import {
  APP_ID, ART, HOME_URL, METRO_LOG, REPO,
  BENIGN_COMMON, die, ensureMetro, log, normalizeTarget, reportSmoke,
  runSmokeSteps, screenshotPath, sleep, tail, unknownCommand,
} from './driver-common.mjs';

const SMOKE_JS_LOG = path.join(ART, 'smoke-js.log');

// Simulator commands can wedge against a busy CoreSimulator; fail loudly
// instead of hanging an agent that is blocked on this process.
const CMD_TIMEOUT_MS = 60_000;
const run = (args, opts = {}) =>
  spawnSync('xcrun', args, { encoding: 'utf8', timeout: CMD_TIMEOUT_MS, ...opts });
function runOrDie(args, what) {
  const r = run(args);
  if (r.status !== 0) die(`${what} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout ?? '';
}

// --- simulator -------------------------------------------------------------

function bootedUDID() {
  const out = run(['simctl', 'list', 'devices', 'booted', '-j']).stdout ?? '{}';
  for (const list of Object.values(JSON.parse(out).devices ?? {})) {
    if (list.length) return list[0].udid;
  }
  return null;
}

function boot(nameOrUdid) {
  const out = runOrDie(['simctl', 'list', 'devices', 'available', '-j'], 'simctl list');
  const all = Object.values(JSON.parse(out).devices).flat();
  const want = nameOrUdid ?? 'iPhone 17';
  const dev = all.find((d) => d.udid === want)
    ?? all.find((d) => d.name === want)
    ?? all.find((d) => d.name.startsWith('iPhone'));
  if (!dev) die(`no simulator matching "${want}"`);
  if (dev.state === 'Booted') {
    log(`already booted: ${dev.name} (${dev.udid})`);
    return dev.udid;
  }
  runOrDie(['simctl', 'boot', dev.udid], 'simctl boot');
  spawnSync('open', ['-a', 'Simulator']);
  // Without this, an immediate launch can race the device coming up.
  run(['simctl', 'bootstatus', dev.udid, '-b'], { timeout: 180_000 });
  log(`booted ${dev.name} (${dev.udid})`);
  return dev.udid;
}

// CoreSimulator shuts devices down on its own (closing Simulator.app, memory
// pressure, a long idle) — including part-way through a smoke run. Re-boot
// rather than dying; the app stays installed across a shutdown.
function requireBooted() {
  return bootedUDID() ?? boot();
}

// Stable for the lifetime of this process, and ~110ms per lookup otherwise.
let containerMemo = null;
function dataContainer() {
  if (containerMemo) return containerMemo;
  requireBooted();
  const r = run(['simctl', 'get_app_container', 'booted', APP_ID, 'data']);
  if (r.status !== 0) die(`${APP_ID} is not installed — run: driver.mjs build`);
  containerMemo = r.stdout.trim();
  return containerMemo;
}

const isInstalled = () =>
  run(['simctl', 'get_app_container', 'booted', APP_ID, 'data']).status === 0;
const isRunning = () =>
  (run(['simctl', 'spawn', 'booted', 'launchctl', 'list']).stdout ?? '').includes(APP_ID);

const urlStorePath = () => path.join(dataContainer(), 'Documents', 'last-url.json');
function readPersisted() {
  try {
    return JSON.parse(readFileSync(urlStorePath(), 'utf8'));
  } catch {
    return null;
  }
}

// --- app lifecycle ---------------------------------------------------------

async function build(release) {
  const udid = boot();
  // Start Metro first. `expo run:ios` reuses a dev server it finds on :8081 and
  // then exits; with no server it hosts Metro itself and never returns, which
  // would wedge this command.
  await ensureMetro();
  const args = ['expo', 'run:ios', '--device', udid];
  if (release) args.push('--configuration', 'Release');
  log(`$ npx ${args.join(' ')}`);
  if (spawnSync('npx', args, { cwd: REPO, stdio: 'inherit' }).status !== 0) die('build failed');
}

const launch = () => log(runOrDie(['simctl', 'launch', 'booted', APP_ID], 'launch').trim());
const stop = () => { run(['simctl', 'terminate', 'booted', APP_ID]); log('terminated'); };
const relaunch = () => { stop(); launch(); };

/**
 * Point the WebView at a URL and relaunch. getInitialURL() reads
 * Documents/last-url.json on cold start, so seeding it is a deterministic
 * navigation primitive — unlike Universal Links, which the Simulator hands to
 * Safari instead (see SKILL.md). Returns the timestamp written.
 */
function goto(target) {
  const { url, rejected } = normalizeTarget(target);
  const file = urlStorePath();
  run(['simctl', 'terminate', 'booted', APP_ID]);
  const timestamp = Date.now();
  writeFileSync(file, JSON.stringify({ url, timestamp }));
  log(`seeded last-url.json → ${url}${rejected ? `  (app will fall back to ${HOME_URL})` : ''}`);
  launch();
  return timestamp;
}

function showState() {
  const docs = path.join(dataContainer(), 'Documents');
  for (const f of readdirSync(docs).filter((f) => f.endsWith('.json'))) {
    const raw = readFileSync(path.join(docs, f), 'utf8');
    // PostHog's own store is thousands of lines of flag payloads; the app's
    // state files (last-url, install-adservices) are the interesting ones.
    if (f.startsWith('.posthog')) { log(`--- ${f} --- (${raw.length} bytes, PostHog SDK store, elided)`); continue; }
    log(`--- ${f} ---`);
    try { log(JSON.stringify(JSON.parse(raw), null, 2)); } catch { log(raw); }
  }
}

// --- observation -----------------------------------------------------------

// The override persists on the device, so applying it once per process is
// enough to keep consecutive screenshots diffable.
let statusBarPinned = false;
async function shot(name = 'shot') {
  requireBooted();
  if (!statusBarPinned) {
    run(['simctl', 'status_bar', 'booted', 'override', '--time', '9:41',
      '--batteryState', 'charged', '--batteryLevel', '100',
      '--cellularBars', '4', '--wifiBars', '3']);
    statusBarPinned = true;
    await sleep(400);
  }
  const out = screenshotPath(name);
  const r = run(['simctl', 'io', 'booted', 'screenshot', '--type', 'png', out]);
  if (r.status !== 0) die(`screenshot failed: ${(r.stderr || '').trim()}`);
  log(out);
  return out;
}

// React Native mirrors every JS console.* into Apple's unified log under this
// subsystem, in Debug *and* Release. Metro's stdout only exists in Debug, so
// this is the build-flavour-independent way to see JS errors.
const CHANNELS = {
  js: { label: 'JS console', predicate: 'subsystem == "com.facebook.react.log"' },
  native: {
    label: 'native',
    predicate: 'processImagePath CONTAINS "3ookcom" AND NOT ('
      + 'subsystem BEGINSWITH "com.apple.network" OR '
      + 'subsystem BEGINSWITH "com.apple.containermanager" OR '
      + 'subsystem BEGINSWITH "com.apple.FileURL")',
  },
};
const logStreamArgs = (predicate) =>
  ['simctl', 'spawn', 'booted', 'log', 'stream', '--style', 'compact', '--predicate', predicate];

// `--style compact` pads the type column to two chars: "E  proc[pid:tid]".
const JS_ERROR_LINE = /^\S+ \S+ (?:E|Fa)\s+\S+\[/;

function sysLog(seconds = 8, channel = 'native', lines = 200) {
  requireBooted();
  const { label, predicate } = CHANNELS[channel] ?? die(`unknown channel: ${channel}`);
  log(`streaming ${label} os_log for ${seconds}s …`);
  // `log stream` never exits on its own, so the timeout is the normal path;
  // anything else (bad predicate, device gone) only shows up on stderr.
  const r = run(logStreamArgs(predicate),
    { timeout: seconds * 1000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error && r.error.code !== 'ETIMEDOUT') die(`log stream failed: ${r.error.message}`);
  if (!r.stdout && r.stderr) log(r.stderr.trim());
  log(tail(r.stdout ?? '', lines));
}

function metroLogs(lines = 60) {
  if (!existsSync(METRO_LOG)) die(`no ${METRO_LOG} — start Metro via: driver.mjs metro`);
  log(spawnSync('tail', ['-n', String(lines), METRO_LOG], { encoding: 'utf8' }).stdout ?? '');
}

// --- composite -------------------------------------------------------------

async function smoke() {
  requireBooted();
  if (!isInstalled()) die('app not installed — run: driver.mjs build');

  // Collect JS console output for the whole run in a detached stream, so this
  // works against a Release build (no Metro) as well as a Debug one.
  const fd = openSync(SMOKE_JS_LOG, 'w');
  const stream = spawn('xcrun', logStreamArgs(CHANNELS.js.predicate),
    { detached: true, stdio: ['ignore', fd, fd] });
  // die() inside a step exits without unwinding, so hang cleanup off `exit`
  // too; the stream is its own process group, hence the negative pid.
  const stopStream = () => { try { process.kill(-stream.pid, 'SIGTERM'); } catch { /* already gone */ } };
  process.on('exit', stopStream);

  let checks;
  try {
    checks = await runSmokeSteps({ goto, shot, readPersisted, prefix: 'smoke' });
  } finally {
    stopStream();
  }

  const errors = readFileSync(SMOKE_JS_LOG, 'utf8').split('\n')
    .filter((l) => JS_ERROR_LINE.test(l))
    .filter((l) => !BENIGN_COMMON.some((re) => re.test(l)));
  reportSmoke({
    running: isRunning(),
    checks,
    persistedURL: readPersisted()?.url ?? '(none)',
    errors,
    extra: [`JS console log:   ${SMOKE_JS_LOG}`],
  });
}

function doctor() {
  const udid = bootedUDID();
  const installed = udid ? isInstalled() : null;
  const rows = [
    ['node', process.version],
    ['.nvmrc', readFileSync(path.join(REPO, '.nvmrc'), 'utf8').trim()],
    ['xcodebuild', (run(['xcodebuild', '-version']).stdout ?? '?').split('\n')[0]],
    ['booted sim', udid ?? '(none)'],
    ['app installed', udid ? (installed ? 'yes' : 'no') : 'n/a'],
    ['app running', udid ? (isRunning() ? 'yes' : 'no') : 'n/a'],
    ['ios/ prebuilt', existsSync(path.join(REPO, 'ios', 'Pods')) ? 'yes' : 'no — run npx expo prebuild'],
    ['.env.local', existsSync(path.join(REPO, '.env.local')) ? 'present' : 'MISSING (Intercom/RevenueCat/PostHog disabled)'],
  ];
  for (const [k, v] of rows) log(`${k.padEnd(16)} ${v}`);
}

// --- cli -------------------------------------------------------------------

const HELP = `
usage: node .claude/skills/run-3ook-com-app/driver.mjs <command>

  doctor              environment + simulator + install state
  boot [name|udid]    boot a simulator (default: iPhone 17)
  build [--release]   npx expo run:ios — compiles, installs, launches, starts Metro
  metro               start Metro detached, logging to .artifacts/metro.log
  launch|stop|relaunch
  goto <url|path>     point the WebView at a URL (seeds last-url.json, relaunches)
  state               dump the app's Documents/*.json (persisted URL, attribution)
  shot [name]         screenshot → .artifacts/shots/<name>.png
  logs [n]            last n lines of Metro output (Debug builds only)
  syslog [sec] [js]   os_log for the app; \`js\` narrows to the JS console
  smoke               drive three routes, screenshot each, assert no JS errors
`.trim();

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'doctor': doctor(); break;
  case 'boot': boot(rest[0]); break;
  case 'build': await build(rest.includes('--release')); break;
  case 'metro': await ensureMetro(); break;
  case 'launch': requireBooted(); launch(); break;
  case 'stop': requireBooted(); stop(); break;
  case 'relaunch': requireBooted(); relaunch(); break;
  case 'goto': requireBooted(); goto(rest[0] ?? '/'); break;
  case 'state': showState(); break;
  case 'shot': await shot(rest[0]); break;
  case 'logs': metroLogs(Number(rest[0]) || 60); break;
  case 'syslog': sysLog(Number(rest[0]) || 8, rest.includes('js') ? 'js' : 'native'); break;
  case 'smoke': await smoke(); break;
  case undefined: case 'help': case '-h': case '--help': log(HELP); break;
  default: unknownCommand(cmd, HELP);
}
