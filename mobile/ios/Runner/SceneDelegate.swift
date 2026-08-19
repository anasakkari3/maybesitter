import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    if let controller = window?.rootViewController as? FlutterViewController {
      PilotPresenceSharedStorePlugin.register(binaryMessenger: controller.binaryMessenger)
      PilotDeepLinkPlugin.register(binaryMessenger: controller.binaryMessenger)
      // Registered here, not only in AppDelegate. Under the scene lifecycle the
      // app delegate's window is nil at didFinishLaunching, so the block there
      // never runs -- and this one was missing, which left the calendar channel
      // unregistered on device while the Swift implementation looked present.
      AppleCalendarImportPlugin.register(binaryMessenger: controller.binaryMessenger)
    }
    if let url = connectionOptions.urlContexts.first?.url {
      PilotDeepLinkPlugin.handle(url: url)
    }
  }

  override func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    if URLContexts.contains(where: { PilotDeepLinkPlugin.handle(url: $0.url) }) {
      return
    }
    super.scene(scene, openURLContexts: URLContexts)
  }
}
