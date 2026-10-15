//
//  SafariWebExtensionHandler.swift
//  Plex to IINA Extension
//
//  Receives { openURL: "iina://open?..." } from background.js and opens it with
//  NSWorkspace, so IINA starts without Safari asking "Allow this page to open IINA?"
//  on every play. Only iina://open links are accepted.
//

import AppKit
import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let log = OSLog(subsystem: "local.plex-to-iina.app.Extension", category: "open")

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]

        // Progress notes from the extension, readable with:
        // log show --last 10m --predicate 'subsystem == "local.plex-to-iina.app.Extension"'
        if let note = message?["log"] as? String {
            os_log(.default, log: log, "%{public}@", note)
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: [:] as [String: Any]]
            context.completeRequest(returningItems: [response], completionHandler: nil)
            return
        }

        var opened = false
        if let text = message?["openURL"] as? String,
           let url = URL(string: text),
           url.scheme == "iina",
           url.host == "open" {
            opened = NSWorkspace.shared.open(url)
            // The URL carries the Plex token, so log only the outcome.
            os_log(.default, log: log, "Asked macOS to open an IINA link: %{public}@", opened ? "ok" : "failed")
        } else {
            os_log(.error, log: log, "Ignored a message that wasn't an iina://open link")
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["opened": opened]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

}
