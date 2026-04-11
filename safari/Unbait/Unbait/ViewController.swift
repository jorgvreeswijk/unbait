//
//  ViewController.swift
//  Unbait
//
//  Created by Jorg Vreeswijk on 22-03-2026.
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "link.unbait.app.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show(\(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show(\(state.isEnabled), false)")
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if (message.body as! String != "open-preferences") {
            return;
        }

        NSLog("Attempting to open Safari Extensions preferences for: \(extensionBundleIdentifier)")
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            DispatchQueue.main.async {
                if let error = error {
                    NSLog("Error opening Safari Extensions preferences: \(error)")
                    let alert = NSAlert()
                    alert.messageText = "Could not open Safari Extensions"
                    alert.informativeText = "Extension ID: \(extensionBundleIdentifier)\nError: \(error.localizedDescription)"
                    alert.runModal()
                    return
                }

                NSLog("Successfully opened Safari Extensions preferences")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    NSApplication.shared.terminate(nil)
                }
            }
        }
    }

}
