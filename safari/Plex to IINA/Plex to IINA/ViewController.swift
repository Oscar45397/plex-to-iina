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
        // The storyboard's web view has a fixed size; let it follow the window.
        webView.translatesAutoresizingMaskIntoConstraints = true
        webView.autoresizingMask = [.width, .height]
        webView.frame = view.bounds

        DownloadManager.shared.onChange = { [weak self] in
            self?.showDownloads()
            self?.showLibrary()
        }
        // The library changes outside the app too (IINA moves watched files to the Trash,
        // Chrome downloads into the folder), so look again every few seconds.
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.showLibrary() }
        }
    }

    override func viewWillAppear() {
        super.viewWillAppear()
        guard let window = view.window else { return }
        window.styleMask.insert([.resizable, .miniaturizable])
        window.minSize = NSSize(width: 420, height: 380)
        if !window.setFrameUsingName("Main") {
            window.setContentSize(NSSize(width: 520, height: 600))
            window.center()
        }
        window.setFrameAutosaveName("Main")
    }

    // The download queue (Downloads.swift) in the page (Script.js).
    private func showDownloads() {
        call("showDownloads", DownloadManager.shared.state())
    }

    private var shownLibrary: [String] = []

    // The files already downloaded (Library.swift), when they've changed.
    private func showLibrary(force: Bool = false) {
        let files = Library.files()
        let signature = files.map { "\($0.url.path)|\($0.size)" }.sorted()
        guard force || signature != shownLibrary else { return }
        shownLibrary = signature
        call("showLibrary", Library.state(files))
    }

    private func call(_ function: String, _ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("\(function)(\(json))")
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
        showLibrary(force: true)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Actions on one downloaded file: { action, id }, where id is its path.
        if let body = message.body as? [String: Any], let action = body["action"] as? String,
           let path = body["id"] as? String, let file = Library.file(at: path) {
            switch action {
            case "play": Library.play(file)
            case "reveal": Library.reveal(file)
            case "trash":
                Library.trash(file)
                showLibrary()
            default: break
            }
            return
        }
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

        // The app stays open: its window is also the downloads library.
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
    }

}
