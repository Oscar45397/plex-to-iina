//
//  KeepAhead.swift
//  Plex to IINA
//
//  Keep ahead: for shows you choose in the extension's Download panel, keep a number of
//  unwatched episodes downloaded. You may not reach the server again for a while, so
//  whenever the app can reach it (every 15 minutes, when the Mac wakes, when the network
//  changes) it fills the lead up completely, rather than waiting until you're nearly out.
//
//  The extension sends plex-to-iina://keep?data=<base64 JSON> with the show and the server
//  address and token it used; a lead of 0 stops keeping the show. While any show is kept,
//  the app keeps running in the background (AppDelegate) and opens at login.
//

import AppKit
import Network
import os.log
import ServiceManagement

struct KeptShow: Codable {
    var server: String  // first 8 characters of the server's machine identifier
    var origin: String  // the server address the browser used
    var token: String
    var showKey: String  // the show's ratingKey
    var title: String
    var lead: Int
    var from: String?  // never fetch episodes before this one (where you started keeping)
    var downloaded: [String] = []  // tags queued for this show, so none is fetched twice
    var ready: Int = 0  // unwatched episodes on this Mac or on their way, at the last check
    var lastReached: Date?

    var id: String { "\(server)-\(showKey)" }
}

final class KeepAhead {

    static let shared = KeepAhead()

    private static let defaultsKey = "keptShows"
    private static let checkEvery: TimeInterval = 15 * 60

    private let log = OSLog(subsystem: "local.plex-to-iina.app", category: "keep-ahead")
    private(set) var shows: [KeptShow] = []
    private var checking = Set<String>()
    private var timer: Timer?
    private let network = NWPathMonitor()
    private var pendingCheck: DispatchWorkItem?

    /// Called on the main thread whenever the list or its status changes.
    var onChange: (() -> Void)?

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let saved = try? JSONDecoder().decode([KeptShow].self, from: data) {
            shows = saved
        }
    }

    // MARK: - Requests from the extension

    /// Handles plex-to-iina://keep?data=<base64 JSON>. Returns whether it was one.
    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard url.scheme == "plex-to-iina", url.host == "keep",
              let encoded = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "data" })?.value,
              let data = Data(base64Encoded: encoded),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let server = request["server"] as? String, server.range(of: #"^[0-9a-f]{8}$"#, options: .regularExpression) != nil,
              let origin = request["origin"] as? String, let base = URL(string: origin),
              ["http", "https"].contains(base.scheme ?? ""), base.path.isEmpty || base.path == "/",
              let showKey = request["showKey"] as? String, showKey.range(of: #"^\d+$"#, options: .regularExpression) != nil,
              let lead = request["lead"] as? Int, (0...30).contains(lead)
        else {
            os_log(.error, log: log, "Ignored a link that wasn't a keep-ahead request")
            return false
        }
        let id = "\(server)-\(showKey)"
        if lead == 0 {
            shows.removeAll { $0.id == id }
            os_log(.default, log: log, "Stopped keeping a show ahead")
        } else if let index = shows.firstIndex(where: { $0.id == id }) {
            shows[index].lead = lead
            shows[index].origin = origin
            shows[index].token = request["token"] as? String ?? ""
        } else {
            shows.append(KeptShow(
                server: server, origin: origin, token: request["token"] as? String ?? "",
                showKey: showKey, title: request["title"] as? String ?? "Show", lead: lead,
                from: (request["from"] as? String).flatMap { $0.range(of: #"^\d+$"#, options: .regularExpression) != nil ? $0 : nil }
            ))
            os_log(.default, log: log, "Keeping a show %d episodes ahead", lead)
        }
        save()
        updateLoginItem()
        if lead > 0 { check(id) }
        return true
    }

    func stop(_ id: String) {
        shows.removeAll { $0.id == id }
        save()
        updateLoginItem()
    }

    // MARK: - When to check

    /// Checks now and from then on every 15 minutes, after the Mac wakes and when the
    /// network changes (for example, back on the home network).
    func start() {
        checkAll()
        timer = Timer.scheduledTimer(withTimeInterval: Self.checkEvery, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkAll() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkSoon() }
        }
        network.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            DispatchQueue.main.async { self?.checkSoon() }
        }
        network.start(queue: .main)
    }

    /// In a moment: the network takes a few seconds to settle after waking or joining.
    private func checkSoon() {
        pendingCheck?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.checkAll() }
        pendingCheck = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }

    func checkAll() {
        for show in shows { check(show.id) }
    }

    // MARK: - Checking one show

    private func check(_ id: String) {
        guard let show = shows.first(where: { $0.id == id }), !checking.contains(id),
              let base = URL(string: show.origin) else { return }
        checking.insert(id)
        // Make sure it's this server before sending the token: on another network the same
        // address can belong to something else.
        var identity = URLRequest(url: base.appendingPathComponent("identity"), timeoutInterval: 8)
        identity.setValue("application/json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: identity) { [weak self] data, _, _ in
            let machine = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])
                .flatMap { $0["MediaContainer"] as? [String: Any] }?["machineIdentifier"] as? String
            DispatchQueue.main.async {
                guard let self else { return }
                guard machine?.lowercased().hasPrefix(show.server) == true else {
                    self.checking.remove(id)  // not reachable from here
                    return
                }
                self.fetchEpisodes(of: show)
            }
        }.resume()
    }

    private func fetchEpisodes(of show: KeptShow) {
        guard let base = URL(string: show.origin) else { return }
        var request = URLRequest(url: base.appendingPathComponent("library/metadata/\(show.showKey)/allLeaves"), timeoutInterval: 20)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !show.token.isEmpty { request.setValue(show.token, forHTTPHeaderField: "X-Plex-Token") }
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let container = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["MediaContainer"] as? [String: Any]
            let episodes = ((container?["Metadata"] as? [[String: Any]]) ?? []).filter { $0["type"] as? String == "episode" }
            DispatchQueue.main.async {
                guard let self else { return }
                self.checking.remove(show.id)
                if ok { self.topUp(show.id, episodes: episodes) }
            }
        }.resume()
    }

    /// Fill the lead up: count the unwatched episodes already here or on their way, then
    /// queue the next ones after the furthest episode watched, downloaded or here.
    private func topUp(_ id: String, episodes all: [[String: Any]]) {
        guard let index = shows.firstIndex(where: { $0.id == id }) else { return }
        var show = shows[index]
        // Specials (season 0) come first in a show; leave them out.
        var episodes = all.filter { number($0["parentIndex"]) != 0 }
        if let from = show.from, let start = episodes.firstIndex(where: { key($0) == from }) {
            episodes = Array(episodes[start...])
        }
        let tag = { (episode: [String: Any]) in "{plex-\(show.server)-\(self.key(episode))}" }
        let watched = { (episode: [String: Any]) in self.number(episode["viewCount"]) > 0 }
        let here = DownloadFolder.existingTags().union(DownloadManager.shared.pendingTags())
        let history = Set(show.downloaded)

        let ready = episodes.filter { here.contains(tag($0)) && !watched($0) }.count
        let frontier = episodes.lastIndex { history.contains(tag($0)) || here.contains(tag($0)) || watched($0) } ?? -1
        let next = episodes.dropFirst(frontier + 1)
            .filter { !watched($0) && !history.contains(tag($0)) }
            .prefix(max(0, show.lead - ready))
        let jobs = next.compactMap { job(for: $0, show: show) }

        show.ready = ready + jobs.count
        show.lastReached = Date()
        show.downloaded.append(contentsOf: jobs.map(\.tag))
        shows[index] = show
        save()
        if !jobs.isEmpty {
            os_log(.default, log: log, "Topping up a kept show with %d episodes", jobs.count)
            DownloadManager.shared.add(jobs)
        }
    }

    // MARK: - Files, named like the extension's (download.js)

    private func job(for episode: [String: Any], show: KeptShow) -> DownloadJob? {
        let media = ((episode["Media"] as? [[String: Any]]) ?? []).sorted {
            (number($0["width"]), number($0["bitrate"])) > (number($1["width"]), number($1["bitrate"]))
        }.first
        guard let part = (media?["Part"] as? [[String: Any]])?.first, let partKey = part["key"] as? String,
              var url = URLComponents(string: show.origin + partKey) else { return nil }
        url.queryItems = [URLQueryItem(name: "download", value: "1")]
        let fileName = part["file"] as? String ?? ""
        let fileExtension = (fileName as NSString).pathExtension.isEmpty
            ? (part["container"] as? String ?? media?["container"] as? String ?? "mkv")
            : (fileName as NSString).pathExtension
        let code = String(format: "S%02dE%02d", number(episode["parentIndex"]), number(episode["index"]))
        let title = Self.cleanName(episode["title"] as? String ?? "")
        let showName = Self.cleanName(episode["grandparentTitle"] as? String ?? show.title)
        let tag = "{plex-\(show.server)-\(key(episode))}"
        var poster: String?
        if let art = episode["grandparentThumb"] as? String ?? episode["parentThumb"] as? String ?? episode["thumb"] as? String,
           var transcode = URLComponents(string: show.origin + "/photo/:/transcode") {
            transcode.queryItems = [
                URLQueryItem(name: "width", value: "192"), URLQueryItem(name: "height", value: "288"),
                URLQueryItem(name: "minSize", value: "1"), URLQueryItem(name: "upscale", value: "1"),
                URLQueryItem(name: "url", value: art),
            ]
            poster = transcode.url?.absoluteString
        }
        let rawTitle = episode["title"] as? String ?? ""
        return DownloadJob(
            tag: tag,
            path: "\(DownloadFolder.name)/\(showName.isEmpty ? "TV" : showName)/\(code)\(title.isEmpty ? "" : " - \(title)") \(tag).\(fileExtension.lowercased())",
            url: url.url?.absoluteString ?? "",
            token: show.token,
            size: Int64(number(part["size"])),
            label: rawTitle.isEmpty ? code : "\(code) · \(rawTitle)",
            poster: poster
        )
    }

    /// Same rules as cleanName in download.js: safe on macOS, no hidden names, not too long.
    static func cleanName(_ text: String) -> String {
        var name = text
        for (pattern, replacement) in [
            (#"[\u0000-\u001f\u007f]"#, ""), (#"\s*:\s*"#, " - "), (#"[\\/]"#, "-"),
            (#"[*?"<>|~]"#, ""), (#"\s+"#, " "), (#"^[\s.-]+|[\s.]+$"#, ""),
        ] {
            name = name.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        return String(name.prefix(100)).trimmingCharacters(in: .whitespaces)
    }

    private func key(_ item: [String: Any]) -> String {
        if let text = item["ratingKey"] as? String { return text }
        return String(number(item["ratingKey"]))
    }

    private func number(_ value: Any?) -> Int {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        if let value = value as? String { return Int(value) ?? 0 }
        return 0
    }

    // MARK: - Saving, login item, and the window

    private func save() {
        if let data = try? JSONEncoder().encode(shows) { UserDefaults.standard.set(data, forKey: Self.defaultsKey) }
        onChange?()
    }

    /// Open at login while any show is kept, so it can catch up whenever you're home.
    func updateLoginItem() {
        let service = SMAppService.mainApp
        do {
            if !shows.isEmpty, service.status != .enabled {
                try service.register()
            } else if shows.isEmpty, service.status == .enabled {
                try service.unregister()
            }
        } catch {
            os_log(.error, log: log, "Couldn't change the login item: %{public}@", error.localizedDescription)
        }
    }

    /// For the window (Script.js, showKept).
    func state() -> [[String: Any]] {
        shows.map { show in
            [
                "id": show.id,
                "title": show.title,
                "lead": show.lead,
                "ready": show.ready,
                "lastReached": show.lastReached.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull(),
                "loginItem": SMAppService.mainApp.status == .enabled ? "on"
                    : SMAppService.mainApp.status == .requiresApproval ? "approve" : "off",
            ]
        }
    }
}
