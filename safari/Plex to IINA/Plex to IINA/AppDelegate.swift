//
//  AppDelegate.swift
//  Plex to IINA
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    private var launchedAtLogin = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        let event = NSAppleEventManager.shared().currentAppleEvent
        launchedAtLogin = event?.eventID == AEEventID(kAEOpenApplication)
            && event?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Posters.prune(keeping: DownloadFolder.existingTags())
        // Once the last download is done, quit if the window was already closed and no show
        // is kept ahead.
        NotificationCenter.default.addObserver(forName: .downloadsFinished, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                if !NSApp.windows.contains(where: \.isVisible), KeepAhead.shared.shows.isEmpty { NSApp.terminate(nil) }
            }
        }
        // Shows kept ahead: keep running without a window or Dock icon, checking for the
        // server in the background (KeepAhead.swift).
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                if !KeepAhead.shared.shows.isEmpty { NSApp.setActivationPolicy(.accessory) }
            }
        }
        if launchedAtLogin, !KeepAhead.shared.shows.isEmpty {
            for window in NSApp.windows { window.orderOut(nil) }
            NSApp.setActivationPolicy(.accessory)
        }
        KeepAhead.shared.updateLoginItem()
        KeepAhead.shared.start()
    }

    // Requests from the extension: downloads (Downloads.swift) and keep ahead (KeepAhead.swift).
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if url.host == "keep" {
                KeepAhead.shared.handle(url)
            } else {
                DownloadManager.shared.handle(url)
            }
        }
    }

    // Opening the app again while it runs in the background brings the window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            NSApp.setActivationPolicy(.regular)
            NSApp.windows.first { $0.contentViewController is ViewController }?.makeKeyAndOrderFront(nil)
            NSApp.activate()
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Keep downloading, or keeping shows ahead, in the background.
        return !DownloadManager.shared.isBusy && KeepAhead.shared.shows.isEmpty
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
