//
//  Downloads.swift
//  Plex to IINA
//
//  Downloads the files for the extension's Download button. Safari gives extensions no way
//  to download, so the extension handler opens plex-to-iina://download?jobs=<base64 JSON>
//  with this app (Info.plist declares the scheme; without that, macOS refuses to hand the
//  link over from the sandboxed extension), and the app downloads them one at a time into
//  ~/Downloads/Plex to IINA:
//  the first episodes are complete first, for example if you leave before the rest are
//  done. Progress shows in the app's window and as a count on its Dock icon.
//
//  When the server stops answering (you leave home mid-download, say), the app looks for
//  another of its addresses that answers (KeepAhead.reach) and carries on there, starting
//  that file over: what was downloaded can only be resumed from the same address. A file
//  that still can't be fetched waits; keep ahead tries it again once the server answers.
//

import AppKit
import os.log

struct DownloadJob: Codable {
    let tag: String
    let path: String
    let url: String
    let token: String
    let size: Int64
    let label: String
    let poster: String?  // a small poster image on the same server, for the library
    var addresses: [String]? = nil  // the server's other addresses (download.js)
}

final class Download {
    nonisolated enum Status: Equatable {
        case queued, downloading, done, failed(String), cancelled
    }

    let job: DownloadJob
    let destination: URL
    var status = Status.queued
    var received: Int64 = 0
    var total: Int64
    var savedAs: URL?
    var resumeData: Data?  // from a stopped or failed download, to carry on where it was
    var origin: String?  // another address of the server to fetch it from, instead of the job's
    var unreachable = false  // failed because the server didn't answer
    var findServer = false  // before (re)starting, look for an address that answers
    var triedElsewhere = false  // already retried once on its own after losing the server

    init(job: DownloadJob, destination: URL) {
        self.job = job
        self.destination = destination
        self.total = job.size
    }
}

final class DownloadManager: NSObject, URLSessionDownloadDelegate {

    static let shared = DownloadManager()

    /// Leave this much free beyond the file itself.
    private static let spareBytes: Int64 = 500_000_000

    private let log = OSLog(subsystem: "local.plex-to-iina.app", category: "download")
    private(set) var items: [Download] = []
    private var current: (item: Download, task: URLSessionDownloadTask)?
    private var findingServer = false
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)

    /// Called on the main thread whenever something changes.
    var onChange: (() -> Void)?

    var isBusy: Bool {
        current != nil || items.contains { $0.status == .queued }
    }

    /// Tags of the files waiting or downloading (for KeepAhead).
    func pendingTags() -> Set<String> {
        Set(items.filter { $0.status == .queued || $0.status == .downloading }.map(\.job.tag))
    }

    // MARK: - Requests from the extension

    /// Handles plex-to-iina://download?jobs=<base64 JSON>. Returns whether it was one.
    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard url.scheme == "plex-to-iina", url.host == "download",
              let encoded = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "jobs" })?.value,
              let data = Data(base64Encoded: encoded),
              let jobs = try? JSONDecoder().decode([DownloadJob].self, from: data)
        else {
            os_log(.error, log: log, "Ignored a link that wasn't a download request")
            return false
        }
        add(jobs)
        return true
    }

    // Any app or web page can open a plex-to-iina:// link, not only the extension, so
    // accept only what the extension sends: Plex media files saved as tagged video files
    // inside the Plex to IINA folder.
    func add(_ jobs: [DownloadJob]) {
        let onDisk = DownloadFolder.existingTags()
        var added = 0
        for job in jobs {
            guard let destination = DownloadFolder.destination(for: job.path),
                  let source = URL(string: job.url), ["http", "https"].contains(source.scheme ?? ""),
                  source.path.hasPrefix("/library/parts/")
            else {
                os_log(.error, log: log, "Refused a download that isn't a Plex media file")
                continue
            }
            // Already here, or already on its way: nothing to do.
            if onDisk.contains(job.tag) { continue }
            if items.contains(where: { $0.job.tag == job.tag && [.queued, .downloading, .done].contains($0.status) }) { continue }
            items.append(Download(job: job, destination: destination))
            if let server = KeepAhead.parse(tag: job.tag)?.server, let origin = KeepAhead.origin(of: source) {
                KeepAhead.shared.remember(server: server, origin: origin, token: job.token, addresses: job.addresses)
            }
            Posters.fetch(for: job)
            added += 1
        }
        os_log(.default, log: log, "Queued %d of %d files", added, jobs.count)
        startNext()
        changed()
    }

    // MARK: - Downloading

    private func startNext() {
        guard current == nil, !findingServer, let item = items.first(where: { $0.status == .queued }),
              let url = source(of: item) else { return }

        if item.findServer, let server = KeepAhead.parse(tag: item.job.tag)?.server {
            findingServer = true
            KeepAhead.shared.reach(server: server, also: [KeepAhead.origin(of: url)].compactMap { $0 }) { [weak self] origin in
                guard let self else { return }
                self.findingServer = false
                item.findServer = false
                if let origin {
                    if origin != KeepAhead.origin(of: url) {
                        os_log(.default, log: self.log, "Downloading %{public}@ from another address of the server", item.job.label)
                        item.origin = origin
                        item.resumeData = nil  // only resumable from the same address
                    }
                } else if item.status == .queued {
                    item.status = .failed("Couldn't reach the server at any of its addresses")
                    item.unreachable = true
                }
                self.startNext()
                self.changed()
            }
            return
        }

        if let free = DownloadFolder.freeBytes(), item.total + Self.spareBytes > free {
            let message = "Not enough disk space (\(Self.format(free)) free)"
            os_log(.error, log: log, "%{public}@", message)
            for waiting in items where waiting.status == .queued { waiting.status = .failed(message) }
            changed()
            return
        }

        // The token goes in a header, not the URL, so it isn't kept anywhere.
        var request = URLRequest(url: url)
        if !item.job.token.isEmpty { request.setValue(item.job.token, forHTTPHeaderField: "X-Plex-Token") }
        request.setValue("Plex to IINA", forHTTPHeaderField: "X-Plex-Product")
        // A slow disk on the server (a NAS waking up) can take a while to start sending.
        request.timeoutInterval = 180
        // Carry on from where it stopped when the server allows it; otherwise start over.
        let task = item.resumeData.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: request)
        item.resumeData = nil
        item.status = .downloading
        current = (item, task)
        task.resume()
        os_log(.default, log: log, "Downloading %{public}@", item.job.label)
    }

    func cancelAll() {
        for item in items where item.status == .queued { item.status = .cancelled }
        if let current {
            current.item.status = .cancelled
            let item = current.item
            current.task.cancel { data in
                DispatchQueue.main.async { item.resumeData = data }
            }
        }
        changed()
    }

    /// Tries the stopped and failed downloads again, from where they were if possible.
    func resumeAll() {
        for item in items {
            switch item.status {
            case .failed, .cancelled:
                requeue(item)
            default: break
            }
        }
        startNext()
        changed()
    }

    /// Queues a stopped or failed download again, first checking which address answers.
    private func requeue(_ item: Download) {
        item.status = .queued
        item.received = 0
        item.unreachable = false
        item.triedElsewhere = false
        item.findServer = true
    }

    /// Downloads from this server that failed because it didn't answer: once it does again
    /// (keep ahead found it), carry on.
    func retryUnreachable(server: String) {
        let waiting = items.filter {
            guard case .failed = $0.status else { return false }
            return $0.unreachable && KeepAhead.parse(tag: $0.job.tag)?.server == server
        }
        guard !waiting.isEmpty else { return }
        waiting.forEach(requeue)
        os_log(.default, log: log, "The server answers again; retrying %d downloads", waiting.count)
        startNext()
        changed()
    }

    /// The file's URL on the address in use: the job's, or another of the server's.
    private func source(of item: Download) -> URL? {
        guard var url = URLComponents(string: item.job.url) else { return nil }
        if let origin = item.origin, let other = URLComponents(string: origin) {
            url.scheme = other.scheme
            url.host = other.host
            url.port = other.port
        }
        return url.url
    }

    /// Errors that mean the server couldn't be reached from here, rather than a problem
    /// with the file.
    private static func isUnreachable(_ error: Error) -> Bool {
        let codes: Set<URLError.Code> = [
            .timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .dnsLookupFailed,
            .notConnectedToInternet, .secureConnectionFailed, .serverCertificateUntrusted,
            .serverCertificateHasBadDate, .serverCertificateNotYetValid, .appTransportSecurityRequiresSecureConnection,
        ]
        return (error as? URLError).map { codes.contains($0.code) } ?? false
    }

    /// Removes the stopped and failed downloads from the list. Kept-ahead shows may then
    /// fetch those episodes again at their next check.
    func clearErrors() {
        let gone = items.filter {
            if case .failed = $0.status { return true }
            return $0.status == .cancelled
        }
        items.removeAll { item in gone.contains { $0 === item } }
        KeepAhead.shared.forget(Set(gone.map(\.job.tag)))
        changed()
    }

    // URLSession calls these on the main queue (see `session`), so they can use the
    // main actor's state directly.

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                                totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        MainActor.assumeIsolated {
            guard let item = current?.item, current?.task === downloadTask else { return }
            item.received = totalBytesWritten
            if totalBytesExpectedToWrite > 0 { item.total = totalBytesExpectedToWrite }
            changed(progressOnly: true)
        }
    }

    // The temporary file is deleted when this returns, so move it now.
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        MainActor.assumeIsolated { saveDownload(downloadTask, from: location) }
    }

    private func saveDownload(_ downloadTask: URLSessionDownloadTask, from location: URL) {
        guard let item = current?.item, current?.task === downloadTask else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            item.status = .failed(status == 403
                ? "The server refused (HTTP 403): downloads may not be allowed for your account"
                : status == 401 ? "The server refused the sign-in (HTTP 401): reload Plex and try again"
                : "The server answered HTTP \(status)")
            return
        }
        do {
            let folder = item.destination.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let target = Self.unused(item.destination)
            try FileManager.default.moveItem(at: location, to: target)
            // URLSession's temporary files are private (rw-------); make it a normal file.
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: target.path)
            item.savedAs = target
            item.status = .done
        } catch {
            item.status = .failed("Couldn't save the file: \(error.localizedDescription)")
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated { finishDownload(task, error: error) }
    }

    private func finishDownload(_ task: URLSessionTask, error: Error?) {
        guard let item = current?.item, current?.task === task else { return }
        current = nil
        if let error, item.status == .downloading {
            item.resumeData = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data
            item.status = .failed(error.localizedDescription)
            item.unreachable = Self.isUnreachable(error)
            // Lost the server: once, right away, look for another address that answers (or
            // the same one, back after a moment) and carry on there.
            if item.unreachable, !item.triedElsewhere,
               let server = KeepAhead.parse(tag: item.job.tag)?.server, KeepAhead.shared.hasOtherAddresses(server) {
                item.status = .queued
                item.unreachable = false
                item.findServer = true
                item.triedElsewhere = true
                os_log(.default, log: log, "Lost the server while downloading %{public}@; looking for it", item.job.label)
            }
        } else if item.status == .downloading {
            item.status = .failed("The download stopped")
        }
        switch item.status {
        case .done: os_log(.default, log: log, "Saved %{public}@", item.job.label)
        case .failed(let why): os_log(.error, log: log, "Failed %{public}@: %{public}@", item.job.label, why)
        default: break
        }
        startNext()
        changed()
    }

    // MARK: - Helpers

    /// The URL itself, or "Name (2).mkv" and so on if a file already has that name.
    private static func unused(_ url: URL) -> URL {
        var candidate = url
        var number = 2
        let base = url.deletingPathExtension().lastPathComponent
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = url.deletingLastPathComponent()
                .appendingPathComponent("\(base) (\(number))")
                .appendingPathExtension(url.pathExtension)
            number += 1
        }
        return candidate
    }

    static func format(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private var lastProgress = Date.distantPast

    private func changed(progressOnly: Bool = false) {
        // Progress arrives many times a second; four updates a second are plenty.
        if progressOnly {
            guard Date().timeIntervalSince(lastProgress) > 0.25 else { return }
            lastProgress = Date()
        }
        let left = items.filter { $0.status == .queued || $0.status == .downloading }.count
        NSApp.dockTile.badgeLabel = left > 0 ? String(left) : nil
        onChange?()
        if !progressOnly, !isBusy { NotificationCenter.default.post(name: .downloadsFinished, object: nil) }
    }

    /// The list for the app's window (Script.js, showDownloads).
    func state() -> [String: Any] {
        let list: [[String: Any]] = items.map { item in
            var entry: [String: Any] = ["label": item.job.label, "received": item.received, "total": item.total]
            switch item.status {
            case .queued: entry["status"] = "queued"
            case .downloading: entry["status"] = "downloading"
            case .done: entry["status"] = "done"
            case .cancelled: entry["status"] = "cancelled"
            case .failed(let why):
                entry["status"] = "failed"
                entry["error"] = why
            }
            return entry
        }
        let stopped = items.contains {
            if case .failed = $0.status { return true }
            return $0.status == .cancelled
        }
        return ["items": list, "busy": isBusy, "stopped": stopped, "folder": DownloadFolder.url.path]
    }

    func revealFolder() {
        let folder = DownloadFolder.url
        if let saved = items.last(where: { $0.savedAs != nil })?.savedAs {
            NSWorkspace.shared.activateFileViewerSelecting([saved])
        } else if FileManager.default.fileExists(atPath: folder.path) {
            NSWorkspace.shared.open(folder)
        } else {
            NSWorkspace.shared.open(DownloadFolder.downloads)
        }
    }
}

extension Notification.Name {
    static let downloadsFinished = Notification.Name("local.plex-to-iina.downloadsFinished")
}
