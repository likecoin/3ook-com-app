# CLAUDE.md

This file is the Claude-facing investigation guide for this repository. Also read
`AGENTS.md`; it contains the general architecture and build conventions shared by
all coding agents.

## 專案定位

`3ook-com-app` 是 3ook.com 的 Expo / React Native native shell，不是主要的
Nuxt web reader repo。App 只有一個主要畫面：`app/index.tsx` 載入
`https://3ook.com?app=1` 到 `react-native-webview`，再用 native bridge 補上登入、
音訊、下載、Intercom、identity tracking、deep link 與 Android/iOS 原生能力。

因此「某一本電子書閱讀失敗」要先判斷失敗發生在：

1. 3ook.com web / backend / 書籍資料或權限。
2. WebView cookie / session / deep link / Android WebView 行為。
3. Native bridge，例如 audiobook 音訊或檔案下載。

如果同一本書在 Android Chrome 或桌面瀏覽器也讀不到，優先查 web/backend repo
`liker-land-v3` 與 3ook.com API，不要先在本 repo 大改。若瀏覽器正常、native app
失敗，才集中查本 repo。

## 常用指令

```bash
npm install
npx expo run:android
npx expo start
npx tsc --noEmit
npx expo lint
```

Android 偵錯常用：

```bash
adb logcat | grep -iE "ReactNativeJS|chromium|WebView|3ook|bridge|audio|Cookie|Sentry"
```

Windows PowerShell 可用：

```powershell
adb logcat | Select-String -Pattern "ReactNativeJS|chromium|WebView|3ook|bridge|audio|Cookie|Sentry"
```

## 閱讀失敗排查流程

先收集最小重現資訊：

- 書籍 URL、book id/slug、章節或頁碼、是否只有某一本失敗。
- Android/iOS、實機或模擬器、OS 版本、App version/build number。
- 登入方式、wallet/user id、是否擁有該書或是否需要 Plus/NFT 權限。
- 失敗畫面文案、network error、HTTP status、console/logcat、Sentry event。
- 同帳號在 Chrome/Safari/桌面 web 是否能閱讀同一本書。

分流判斷：

- Web 也失敗：多半是 web reader、API、書籍資料、權限、CDN 或檔案來源問題。到
  `liker-land-v3` 查 reader route、book API、ownership/permission check、asset URL。
- Web 正常但 native 失敗：查 `app/index.tsx` 的 WebView loading、cookie/session、
  navigation interception、Android WebView console/logcat。
- 只有 audiobook 播放失敗：查 `services/audio-bridge.native.ts`。
- 只有匯出/下載失敗：查 `services/download-bridge.native.ts` 與 web 送出的
  `fileDownloadData` message。

## 先抓證據

### Dev build：內建 WebView debug log（最快、不用接 Chrome）

Dev build（`__DEV__`，即 `npx expo run:android` 或連 Metro）會在 `app/index.tsx` 注入
`WEBVIEW_DEBUG_BOOTSTRAP`，把 WebView **頁內**錯誤 forward 回 native，logcat 以
`[WebView debug]` 印出，不用接 `chrome://inspect` 就能看書頁失敗原因：

- `window.error`、`unhandledrejection`：web reader 的 JS 例外。
- `fetch` / `XMLHttpRequest` 回 HTTP ≥ 400：書籍 API、章節、asset 載入失敗的 URL +
  status（URL 已 sanitize 成 origin+pathname，不含 token/query）。
- `console.error`：web 端主動印的錯誤。

```powershell
adb logcat | Select-String -Pattern "WebView debug|WebView HTTP error|WebView navigation|bridge"
```

「某本書讀不到」最常見就是這裡冒出某支書籍 API 或 asset 的 4xx/5xx，或一個 reader JS
例外——先看是哪個 host / status，再決定查 web/backend 還是本 repo。

### Release build / 遠端回報：查既有事件

沒有本機重現時，用既有 analytics（PostHog / Firebase）與 Sentry 事件定位：

- WebView：`webview_load_failed`(code/domain/description)、`webview_load_retry`、
  `webview_load_recovered`、`webview_render_process_gone`(did_crash)、
  `webview_content_terminated`。
- Audio：`audio_session_started`、`audio_track_advanced`(preload_state)、
  `audio_playback_failed`、`audio_queue_ended`、`audio_session_stopped`。
- 導航：`deep_link_opened`、`external_url_opened`、`launched_with_deep_link`。
- Sentry 在 `app/_layout.tsx` init（`sendDefaultPii: true`）；native crash 走 Firebase
  Crashlytics。Release build 看不到 `[WebView debug]`，只能靠這些事件或 `chrome://inspect`。

## 本 repo 相關入口

- `app/index.tsx`：WebView host。重點看 `source`、`userAgent`、`sharedCookiesEnabled`、
  `onShouldStartLoadWithRequest`、`onNavigationStateChange`、`onError`、`onHttpError`、
  `onMessage`。
- `services/url-storage.native.ts`：保存上次 URL，會強制補 `app=1`，有效期 24 小時。
  若 App 一開就回到某本壞書，這裡可能讓錯誤 URL 被恢復。
- `services/url-bridge.native.ts`：外部 URL / wallet deep link 交給 OS 開啟。
- `services/bridge-dispatcher.ts`：WebView `postMessage` JSON dispatcher。未知或 malformed
  message 只會 `console.warn`。
- `services/wallet-auth-bridge.ts` 與 `services/likecoin-auth-api.ts`：MetaMask native login，
  成功後把 3ook.com 回傳的 `nuxt-session` cookie 寫入 WebView cookie jar。
- `services/audio-bridge.native.ts`：web 送 `load/pause/resume/stop/skipTo/setRate/seekTo`
  控制 native audiobook。音訊 URL 會從第一個 track URL 讀 cookie 後放到 `Cookie`
  request header。
- `services/download-bridge.native.ts`：web 送 base64 檔案內容後寫入 cache 並呼叫分享。
- `app.config.ts`：Android package、intent filter、permissions、Expo plugins。

## Native shell 常見嫌疑點

### Cookie / 登入狀態

3ook.com 前端依賴 `nuxt-session` cookie。`app/index.tsx` 用
`CookieManager.get('https://3ook.com')` 判斷是否登入；native MetaMask login 會在
`wallet-auth-bridge.ts` 用 `CookieManager.setFromResponse()` 寫回 `https://3ook.com`
與 `https://www.3ook.com`。

排查時確認：

- WebView request 是否帶 `nuxt-session`。
- 登入後是否有 `CookieManager.flush()` warning。
- 書籍 API 是否回 401/403。
- Android WebView 與 RN fetch cookie jar 是分開的，不能假設 fetch 登入等於 WebView 已登入。

### WebView 導航與錯誤

`app/index.tsx` 會攔截 top-frame 非 app-bound host 並交給外部瀏覽器。若閱讀器或書籍
asset 需要跳到非 3ook.com host，確認它是否應該留在 WebView，或只是 iframe/resource
載入。`onHttpError` 只 `console.warn('[WebView HTTP error]', { statusCode, description, url })`
（URL 已 sanitize 成 origin+pathname），不會擋畫面，因此 logcat 是重要線索。注意它只涵蓋
**top-frame 主文件**的 HTTP 錯誤；頁內 API/asset 的 4xx 要看下方 dev debug log 的 fetch/xhr。

要特別看：

- `onError` 的 `code/domain/description`。
- `onHttpError` 的 URL 與 status code。
- `onShouldStartLoadWithRequest` 是否把應在 App 內開的 URL 攔到外部瀏覽器。
- last URL 是否被 `url-storage` 還原成舊的失敗閱讀頁。

### WebView crash / 自動重試 lifecycle

有些「特定書讀不到」其實是 WebView render process 被打掛（大 EPUB/PDF、巨量圖片、
記憶體吃滿），不是 web 邏輯錯：

- Android `onRenderProcessGone` / iOS `onContentProcessDidTerminate` 會 remount/reload
  WebView，畫面看起來像自己重整或閃一下。事件：`webview_render_process_gone`(did_crash)、
  `webview_content_terminated`。**若某本書一開就崩、其他書正常 → 高度懷疑該書內容讓
  renderer OOM**。
- Cold start 載入失敗走自動重試 ladder `[250, 750, 1000, 2500]ms`（`MAX_AUTO_RETRIES = 4`），
  全失敗才顯示「Can't reach 3ook.com」overlay；偶發、可手動 Retry 復原 → 多半是網路 /
  cold start，不是該書問題。
- `onError` 的 `code === -999`（NSURLErrorCancelled）是把導航讓給外部瀏覽器時的正常取消，
  會被忽略，**不要**當成載入失敗。

### Android WebView

Android 方向優先檢查：

- Chrome remote debugging / WebView console 是否有 JS exception。
- Mixed content、CORS、CSP、service worker/cache、PDF/EPUB reader resource loading。
- 某本書若 asset URL 在不同 host，確認 WebView 是否能載入該 host。
- App UA 是 `3ook-com-app/<version> (Android <version>) Build/<build>`；web 可能依 UA 或
  `app=1` 切功能。

### Audiobook / TTS

若使用者說「閱讀」其實是 audiobook 播放失敗，查
`services/audio-bridge.native.ts`：

- `load` message 的 `tracks` 是否為空、`startIndex` 是否有效。
- Android 會移除 track URL 的 `blocking` query param。
- Cookie header 只從第一個 track URL 讀取後共用到整個 queue；若某本書 tracks 跨 host，
  可能造成後續 track 權限不足。
- `audio_playback_failed`、`Playback stuck`、`playbackState: buffering` 是關鍵線索。

## 建議加的暫時 instrumentation

若需要在本 repo 加 debug，先用短期、可移除的 log，不要記錄完整 wallet link、session
cookie、簽名、個資或完整受保護 asset URL。

可安全記錄：

- book id/slug、route path、host、HTTP status。
- WebView `onError` / `onHttpError` 的 code、domain、description、host。
- bridge message `type`，但不要 dump 整個 payload。
- audio track count、start index、track host、是否有 cookie header。

避免記錄：

- `nuxt-session`、`Set-Cookie`、wallet signature、完整 wallet connect URL。
- 完整 private asset URL，尤其是帶 token/query 的 URL。

## 修正原則

- 先用重現與 log 定位責任邊界；不要把 web/backend 問題硬塞 native workaround。
- 若問題只影響特定書籍，優先檢查該書資料、權限、asset host、檔案格式與 API 回應。
- 若需要改 native WebView 行為，保持範圍小，並同時驗證登入、一般閱讀、audiobook、
  wallet deep link、外部連結與返回鍵。
- 文件或小修可直接改；會影響登入、cookie、bridge protocol、音訊 session 的改動要跑
  Android 實機測試。