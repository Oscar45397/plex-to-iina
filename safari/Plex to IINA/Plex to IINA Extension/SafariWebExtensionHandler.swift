//
//  SafariWebExtensionHandler.swift
//  Plex to IINA Extension
//
//  Receives { openURL: "iina://open?..." } from background.js and opens it with
//  NSWorkspace, so IINA starts without Safari asking "Allow this page to open IINA?"
//  on every play. Only iina://open links are accepted.
//
//  Also serves the Download button: { downloadCheck: { tags } } answers which files are
//  already in ~/Downloads/Plex to IINA and how much space is free, and { download: { jobs } }
//  hands the files to the app, which downloads them (Downloads.swift). This handler only
//  runs for a moment per message, too short for a download.
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

        if let check = message?["downloadCheck"] as? [String: Any] {
            let tags = check["tags"] as? [String] ?? []
            let existing = DownloadFolder.existingTags()
            reply(context, [
                "existing": tags.filter { existing.contains($0) },
                "freeBytes": DownloadFolder.freeBytes().map { NSNumber(value: $0) } ?? NSNull(),
            ])
            return
        }
        if let download = message?["download"] as? [String: Any] {
            startDownloads(download["jobs"] as? [[String: Any]] ?? [], context: context)
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

    // Opens plex-to-iina://download?jobs=<base64 JSON> with the app that contains this
    // extension, in the background. The jobs include the Plex token, so log only counts.
    private func startDownloads(_ jobs: [[String: Any]], context: NSExtensionContext) {
        var link = URLComponents()
        link.scheme = "plex-to-iina"
        link.host = "download"
        guard !jobs.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: jobs) else {
            reply(context, ["error": "nothing to download"])
            return
        }
        link.queryItems = [URLQueryItem(name: "jobs", value: data.base64EncodedString())]
        // …/Plex to IINA.app/Contents/PlugIns/Plex to IINA Extension.appex
        let app = Bundle.main.bundleURL
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        NSWorkspace.shared.open([link.url!], withApplicationAt: app, configuration: configuration) { [log] _, error in
            if let error {
                os_log(.error, log: log, "Couldn't hand %d downloads to the app: %{public}@", jobs.count, error.localizedDescription)
                self.reply(context, ["error": "couldn't open the Plex to IINA app"])
            } else {
                os_log(.default, log: log, "Handed %d downloads to the app", jobs.count)
                self.reply(context, ["queued": jobs.count, "where": "app"])
            }
        }
    }

    private func reply(_ context: NSExtensionContext, _ message: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: message]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

}
