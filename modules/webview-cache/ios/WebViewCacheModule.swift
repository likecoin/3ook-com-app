import ExpoModulesCore
import WebKit

public class WebViewCacheModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WebViewCache")

    // Last-resort recovery for the stale-chunk loop: after a deploy rehashes
    // /_nuxt/*.js, WebKit keeps re-serving a cached "/" shell that references the
    // deleted hashes, and this survives force-quit. RNCWebView's own clearCache
    // omits WKWebsiteDataTypeServiceWorkerRegistrations — the exact type that
    // holds the SW re-serving that shell — so we clear it here. Cookies and
    // LocalStorage are deliberately preserved so Cloudflare Access auth and the
    // web chunk-error ladder state survive the wipe.
    AsyncFunction("clearWebViewCache") { (promise: Promise) in
      let types: Set<String> = [
        WKWebsiteDataTypeServiceWorkerRegistrations,
        WKWebsiteDataTypeDiskCache,
        WKWebsiteDataTypeMemoryCache,
        WKWebsiteDataTypeFetchCache,
        WKWebsiteDataTypeOfflineWebApplicationCache,
      ]
      let store = WKWebsiteDataStore.default()
      DispatchQueue.main.async {
        store.removeData(
          ofTypes: types,
          modifiedSince: Date(timeIntervalSince1970: 0)
        ) {
          promise.resolve(nil)
        }
      }
    }
  }
}
