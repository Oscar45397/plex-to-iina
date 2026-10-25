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
//  runs for a moment per message, too short for a download. And for Play,
//  { downloadFind: { tag } } answers the path of a downloaded copy, which IINA then plays.
//  { keepAhead: { … } } hands a show to keep ahead to the app (KeepAhead.swift).
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
        if let find = message?["downloadFind"] as? [String: Any] {
            let file = (find["tag"] as? String).flatMap { DownloadFolder.file(withTag: $0) }
            reply(context, ["path": file?.path ?? NSNull()])
            return
        }
        if let download = message?["download"] as? [String: Any] {
            let jobs = download["jobs"] as? [[String: Any]] ?? []
            openApp("download", "jobs", jobs.isEmpty ? nil : jobs, context: context, reply: ["queued": jobs.count, "where": "app"])
            return
        }
        if let keep = message?["keepAhead"] as? [String: Any] {
            openApp("keep", "data", keep, context: context, reply: ["handled": true])
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

    // Opens plex-to-iina://<host>?<name>=<base64 JSON> with the app that contains this
    // extension, in the background. The payload includes the Plex token, so log no details.
    private func openApp(_ host: String, _ name: String, _ payload: Any?, context: NSExtensionContext, reply success: [String: Any]) {
        var link = URLComponents()
        link.scheme = "plex-to-iina"
        link.host = host
        guard let payload, let data = try? JSONSerialization.data(withJSONObject: payload) else {
            reply(context, ["error": "nothing to send to the app"])
            return
        }
        link.queryItems = [URLQueryItem(name: name, value: data.base64EncodedString())]
        // …/Plex to IINA.app/Contents/PlugIns/Plex to IINA Extension.appex
        let app = Bundle.main.bundleURL
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        NSWorkspace.shared.open([link.url!], withApplicationAt: app, configuration: configuration) { [log] _, error in
            if let error {
                os_log(.error, log: log, "Couldn't hand a %{public}@ request to the app: %{public}@", host, error.localizedDescription)
                self.reply(context, ["error": "couldn't open the Plex to IINA app"])
            } else {
                os_log(.default, log: log, "Handed a %{public}@ request to the app", host)
                self.reply(context, success)
            }
        }
    }

    private func reply(_ context: NSExtensionContext, _ message: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: message]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

}
