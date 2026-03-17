# 3ook.com App

Native mobile app for [3ook.com](https://3ook.com) — a decentralized digital bookstore where books are readable, listenable, and ownable (可讀、可聽、可擁有).

This is a WebView shell built with [Expo](https://expo.dev) that wraps the 3ook.com web app and adds native audio playback with background audio, lock screen controls, and queue management via `expo-audio`.

**Tech stack:** Expo SDK 55, React Native 0.83, React 19.2, TypeScript, expo-audio, expo-router, Sentry.

[App Store](https://apps.apple.com/hk/app/id6757783481) · [Google Play](https://play.google.com/store/apps/details?id=land.liker.book3app)

## Setup

```bash
npm install
npx expo prebuild --clean
```

## Development

```bash
npx expo run:ios       # Build and run on iOS simulator
npx expo run:android   # Build and run on Android emulator
npx expo start         # Start Metro dev server (for dev client)
```

## Lint & Typecheck

```bash
npx expo lint
npx tsc --noEmit
```

## EAS Build

```bash
eas build --profile development --platform ios
eas build --profile production --platform all
```

See `eas.json` for build profiles.
