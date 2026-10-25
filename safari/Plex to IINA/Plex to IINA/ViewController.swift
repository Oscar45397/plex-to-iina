//
//  ViewController.swift
//  Plex to IINA
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "local.plex-to-iina.app.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)

        DownloadManager.shared.onChange = { [weak self] in self?.showDownloads() }
    }

    // The download list (Downloads.swift) in the page (Script.js).
    private func showDownloads() {
        guard let data = try? JSONSerialization.data(withJSONObject: DownloadManager.shared.state()),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("showDownloads(\(json))")
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
        showDownloads()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.body as? String {
        case "show-downloads":
            DownloadManager.shared.revealFolder()
            return
        case "cancel-downloads":
            DownloadManager.shared.cancelAll()
            return
        case "open-preferences":
            break
        default:
            return
        }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }

}
