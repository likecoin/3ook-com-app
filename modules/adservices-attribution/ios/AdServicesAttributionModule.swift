import AdServices
import ExpoModulesCore

public class AdServicesAttributionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AdServicesAttribution")

    // Fail-soft per repo convention: never rejects. Resolves { token } or
    // { error } so JS can tell a retryable failure from a terminal one.
    // attributionToken() does I/O, so keep it off the caller's thread.
    AsyncFunction("getAttributionToken") { (promise: Promise) in
      DispatchQueue.global(qos: .utility).async {
        do {
          promise.resolve(["token": try AAAttribution.attributionToken()])
        } catch let error as NSError {
          promise.resolve(["error": Self.classify(error)])
        }
      }
    }
  }

  // The Simulator has no AdServices and reports platformNotSupported, which is
  // terminal. Network/internal errors are transient and worth another launch.
  private static func classify(_ error: NSError) -> String {
    guard let code = AAAttributionError.Code(rawValue: error.code) else { return "unknown" }
    switch code {
    case .networkError: return "network"
    case .internalError: return "internal"
    case .platformNotSupported: return "unsupported"
    @unknown default: return "unknown"
    }
  }
}
