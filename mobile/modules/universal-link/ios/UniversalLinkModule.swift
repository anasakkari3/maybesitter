import ExpoModulesCore
import UIKit

/// Opens an https link in the app that claims it, and only there (closure CL2b, #21).
///
/// `Linking.openURL` hands a universal link to the installed app when there is
/// one — and to Safari when there is not. For `https://chatgpt.com/app` Safari
/// then follows a 302 to the App Store, which is not where somebody who wanted
/// to paste a question meant to go. `.universalLinksOnly` opens the link only
/// if an installed app claims it and otherwise opens nothing, so JavaScript
/// learns which happened and can send the web chat URL instead.
public class UniversalLinkModule: Module {
  public func definition() -> ModuleDefinition {
    Name("UniversalLink")

    // On the main queue: UIApplication.open must be called from the main thread.
    AsyncFunction("openUniversalLink") { (urlString: String, promise: Promise) in
      guard let url = URL(string: urlString), url.scheme == "https" else {
        promise.resolve(false)
        return
      }
      UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { opened in
        promise.resolve(opened)
      }
    }.runOnQueue(.main)
  }
}
