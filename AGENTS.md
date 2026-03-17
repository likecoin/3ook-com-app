# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Cursor, Copilot, etc.) when working with code in this repository.

## Build & Development Commands

```bash
npm install                # Install dependencies
npx expo prebuild --clean  # Generate native projects (ios/ and android/)
npx expo run:ios           # Build and run on iOS simulator
npx expo run:android       # Build and run on Android emulator
npx expo start             # Start Metro dev server
npx tsc --noEmit           # Typecheck
npx expo lint              # Lint (ESLint via Expo)
```

EAS builds: `eas build --profile development|preview|production --platform ios|android`

## What This App Is

Native mobile app for [3ook.com](https://3ook.com) — a decentralized digital bookstore where books are readable, listenable, and ownable (可讀、可聽、可擁有). The platform features 1000+ books with AI-generated Cantonese/Mandarin/English narration, blockchain-based book ownership on Base, and an author-friendly revenue model.

The web app itself lives in a separate repo (`liker-land-v3`, a Nuxt 3 PWA). This repo is the **native shell** — a WebView wrapper that adds native audio playback with background audio, lock screen controls, and queue management.

## Architecture

### How it works

1. **`app/index.tsx`** — Single-screen app rendering a full-screen `WebView` at `https://3ook.com?app=1`. Listens for `postMessage` events from the web app.
2. **`services/audio-bridge.native.ts`** — Imperative audio engine using `expo-audio`. Manages a single `AudioPlayer`, a manual track queue, cookie forwarding (Cloudflare Access auth), lock screen controls, and auto-advancement.
3. **`services/audio-bridge.web.ts`** — No-op stub so web builds compile without native audio dependencies.
4. **`services/audio-bridge.d.ts`** — Shared type declarations for the platform-split module.
5. **`plugins/withAndroidAudioService.js`** — Config plugin registering Android `AudioControlsService` for foreground media playback.

### Key patterns

- **Platform-split modules**: `audio-bridge` uses `.native.ts` / `.web.ts` suffixes with a shared `.d.ts`. Metro resolves the correct file per platform.
- **WebView ↔ Native bridge**: Web→Native via `postMessage` JSON. Native→Web via `injectJavaScript` dispatching `CustomEvent('nativeAudioEvent')`.
- **Cookie forwarding**: Audio URLs require Cloudflare Access cookies. The bridge reads cookies via `react-native-cookie-manager` and passes them as request headers to `expo-audio`.

### Message protocol

Web app sends JSON via `postMessage` with `type`: `load`, `pause`, `resume`, `stop`, `skipTo`, `setRate`, `seekTo`. Native sends back events (`playbackState`, `trackChanged`, `queueEnded`) via `CustomEvent`.

## Commit Messages

Gitmoji style: `⬆️ Upgrade dependencies`, `✨ Add feature`, `🐛 Fix bug`, etc.
