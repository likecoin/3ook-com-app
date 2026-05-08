# Copilot Instructions for `likecoin/3ook-com-app`

## What this repository is
- This is the native mobile shell for **3ook.com** (Expo + React Native), not the main web app.
- The app is primarily a full-screen `WebView` that loads `https://3ook.com?app=1` and extends it with native capabilities (audio playback, downloads, identity/intercom bridges, deep-link handling).

## Tech stack and baseline assumptions
- Expo SDK 55, React Native 0.83, React 19, TypeScript strict mode.
- Package manager: **npm** (`package-lock.json` is committed).
- CI uses Node 22 and runs:
  1. `npm ci`
  2. `npm run lint`
  3. `npx tsc --noEmit`
  4. `npx expo export --platform web`

## Fastest way to be productive in a fresh cloud-agent session
1. Install dependencies:
   - `npm install` (or `npm ci` if lockfile must be strictly honored).
2. Validate before/after changes with the same commands as CI:
   - `npm run lint`
   - `npx tsc --noEmit`
   - `npx expo export --platform web`
3. For native-specific work, inspect these first:
   - `app/index.tsx`
   - `services/audio-bridge.native.ts`
   - `services/bridge-dispatcher.ts`
   - `app.config.ts`

## Architecture map (high value files)
- `app/index.tsx`
  - Hosts WebView and dispatches incoming `postMessage` payloads to native handlers.
  - Injects `window.__nativeBridge.features` via `injectedJavaScriptBeforeContentLoaded` for web-side feature detection.
- `services/bridge-dispatcher.ts`
  - Central registry/dispatcher for message handlers keyed by `type`.
- `services/audio-bridge.native.ts`
  - Main native audio engine (`expo-audio`) with queueing, preload/swap logic, lock screen integration, interruption handling, and cookie forwarding.
- `services/*.native.ts` + `services/*.web.ts` + `services/*.d.ts`
  - Platform-split pattern used across bridges. Keep signatures aligned with the `.d.ts` facade.
- `services/url-storage.native.ts`
  - Deep links accepted only for `3ook.com` and subdomains; URL normalization always enforces `app=1`.
- `services/app-bound-domains.js` + `plugins/withAppBoundDomains.js`
  - Single source of truth for iOS app-bound domains shared by runtime checks and config plugin.
- `app.config.ts`
  - Expo app config and plugin ordering; Intercom plugin is conditionally enabled by env vars.

## Bridge protocol expectations
- Web → Native messages are JSON with `type` and payload fields.
- Core audio message types: `load`, `pause`, `resume`, `stop`, `skipTo`, `setRate`, `seekTo`.
- Native → Web events are sent as `CustomEvent` from injected JS (`nativeAudioEvent` and `nativeBridgeEvent`).
- If adding a new bridge capability that web must detect, update `NATIVE_BRIDGE_FEATURES` in `app/index.tsx`.

## Change guidelines for this codebase
- Keep changes surgical; this repo is a thin native shell around web content.
- Preserve platform-split module behavior (`.native.ts` / `.web.ts` / `.d.ts`).
- When touching `app.config.ts`, be careful with plugin order (notably Intercom vs notification-related plugins).
- Follow existing commit style when relevant (Gitmoji prefixes are used in docs/examples).

## Errors encountered during onboarding and workarounds
1. **Stale plugin reference in agent docs**
   - Encountered: the current `AGENTS.md`/`CLAUDE.md` files mention `plugins/withAndroidAudioService.js`, but this file does not exist in the repository.
   - Workaround: treat `plugins/withAppBoundDomains.js` and the plugin list in `app.config.ts` as the canonical plugin configuration sources.

2. **No `app.json` present**
   - Encountered: Expo app config is not in `app.json`.
   - Workaround: use `app.config.ts` as the source of truth for app metadata, plugins, and environment-variable-driven behavior.

3. **Intercom env vars absent in default environment**
   - Encountered: commands print `[intercom] INTERCOM_APP_ID / INTERCOM_IOS_API_KEY / INTERCOM_ANDROID_API_KEY missing — Intercom plugin disabled in this build.`
   - Workaround: for tasks unrelated to Intercom, this warning is expected and non-blocking; for Intercom work, define those env vars before running Expo commands.

4. **Dependency health warnings during install**
   - Encountered: `npm install` reports deprecation warnings and an `npm audit` vulnerability summary.
   - Workaround: these warnings did not block lint/typecheck/export in this repo state; avoid opportunistic dependency churn unless the task explicitly requires upgrades.
