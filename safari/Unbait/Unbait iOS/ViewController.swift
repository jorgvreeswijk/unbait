//
//  ViewController.swift
//  Unbait iOS
//
//  Created by Jorg Vreeswijk on 17/04/2026.
//

import UIKit
import WebKit

class ViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        // Allow scrolling so longer content (About sections) is reachable
        self.webView.scrollView.isScrollEnabled = true
        self.webView.scrollView.contentInsetAdjustmentBehavior = .always
        // Transparent so CSS background (incl. dark mode) shows through
        self.webView.isOpaque = false
        self.webView.backgroundColor = .systemBackground
        self.webView.scrollView.backgroundColor = .systemBackground

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    // Intercept link clicks: open external URLs (https, mailto) in Safari/Mail
    // instead of navigating inside the in-app WKWebView.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
            let scheme = url.scheme?.lowercased() ?? ""
            if scheme == "http" || scheme == "https" || scheme == "mailto" {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Override point for customization.
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else { return }
        switch body {
        case "open-settings":
            let candidates = [
                "App-prefs:Safari&path=WEB_EXTENSIONS",
                "App-prefs:Safari",
                UIApplication.openSettingsURLString
            ]
            for urlString in candidates {
                if let url = URL(string: urlString), UIApplication.shared.canOpenURL(url) {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                    break
                }
            }
        default:
            break
        }
    }
}
