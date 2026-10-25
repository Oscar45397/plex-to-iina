//
//  AppDelegate.swift
//  Plex to IINA
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Once the last download is done, quit if the window was already closed.
        NotificationCenter.default.addObserver(forName: .downloadsFinished, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                if !NSApp.windows.contains(where: \.isVisible) { NSApp.terminate(nil) }
            }
        }
    }

    // Download requests from the extension (see Downloads.swift).
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { DownloadManager.shared.handle(url) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Keep downloading in the background; quit when they're done.
        return !DownloadManager.shared.isBusy
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard DownloadManager.shared.isBusy else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "Stop downloading?"
        alert.informativeText = "Quitting stops the download in progress and the ones waiting."
        alert.addButton(withTitle: "Keep Downloading")
        alert.addButton(withTitle: "Quit")
        return alert.runModal() == .alertSecondButtonReturn ? .terminateNow : .terminateCancel
    }

}
