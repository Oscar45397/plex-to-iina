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

import AppKit
import os.log

struct DownloadJob: Codable {
    let tag: String
    let path: String
    let url: String
    let token: String
    let size: Int64
    let label: String
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
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)

    /// Called on the main thread whenever something changes.
    var onChange: (() -> Void)?

    var isBusy: Bool {
        current != nil || items.contains { $0.status == .queued }
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
            added += 1
        }
        os_log(.default, log: log, "Queued %d of %d files", added, jobs.count)
        startNext()
        changed()
    }

    // MARK: - Downloading

    private func startNext() {
        guard current == nil, let item = items.first(where: { $0.status == .queued }),
              let url = URL(string: item.job.url) else { return }

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
        let task = session.downloadTask(with: request)
        item.status = .downloading
        current = (item, task)
        task.resume()
        os_log(.default, log: log, "Downloading %{public}@", item.job.label)
    }

    func cancelAll() {
        for item in items where item.status == .queued { item.status = .cancelled }
        if let current {
            current.item.status = .cancelled
            current.task.cancel()
        }
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
            item.status = .failed(error.localizedDescription)
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
        return ["items": list, "busy": isBusy, "folder": DownloadFolder.url.path]
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
