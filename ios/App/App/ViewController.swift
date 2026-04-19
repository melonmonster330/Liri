import UIKit
import Capacitor
import CapApp_SPM

/// Custom bridge view controller that explicitly registers local SPM plugins.
/// Capacitor 8's auto-discovery doesn't find classes in local SPM packages —
/// capacitorDidLoad() is the correct hook to manually register them.
class ViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginType(NativeAudioPlugin.self)
        bridge?.registerPluginType(ShazamPlugin.self)
    }
}
