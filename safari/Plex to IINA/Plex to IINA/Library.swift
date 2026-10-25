//
//  Library.swift
//  Plex to IINA
//
//  The downloads already on disk, for the app's window: shows with their episodes, and
//  films, each with a poster, played in IINA with one click. It reads the files in
//  ~/Downloads/Plex to IINA, so it also lists what Chrome downloaded there.
//

import AppKit

struct LibraryFile {
    let url: URL
    let tag: String
    let show: String?  // the show's folder; nil for a film
    let code: String?  // "S01E02"
    let title: String  // the episode's title, or the film's "Title (Year)"
    let size: Int64
}

enum Library {

    /// Files named by the extension: "<Show>/S01E02 - Title {tag}.mkv" or "Title (Year) {tag}.mkv".
    static func files() -> [LibraryFile] {
        let root = DownloadFolder.url.standardizedFileURL.path
        return DownloadFolder.files().compactMap { url in
            guard let tag = DownloadFolder.tag(in: url.lastPathComponent) else { return nil }
            let name = url.deletingPathExtension().lastPathComponent
                .replacingOccurrences(of: tag, with: "")
                .trimmingCharacters(in: .whitespaces)
            let folder = url.deletingLastPathComponent().standardizedFileURL
            let show = folder.path == root ? nil : folder.lastPathComponent
            var code: String?
            var title = name
            if show != nil, let range = name.range(of: #"^S\d+E\d+"#, options: .regularExpression) {
                code = String(name[range])
                title = String(name[range.upperBound...])
                    .trimmingCharacters(in: .whitespaces)
                    .replacingOccurrences(of: #"^-\s*"#, with: "", options: .regularExpression)
            }
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            return LibraryFile(url: url, tag: tag, show: show, code: code, title: title, size: size)
        }
    }

    /// For the window (Script.js, showLibrary): shows by name with episodes in order, then films.
    static func state(_ files: [LibraryFile]) -> [String: Any] {
        let episodes = Dictionary(grouping: files.filter { $0.show != nil }, by: { $0.show! })
        let shows: [[String: Any]] = episodes.keys
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            .map { name in
                let list = episodes[name]!.sorted { ($0.code ?? "").localizedStandardCompare($1.code ?? "") == .orderedAscending }
                return [
                    "name": name,
                    "poster": list.lazy.compactMap { Posters.dataURL(for: $0.tag) }.first ?? NSNull(),
                    "size": list.reduce(0) { $0 + $1.size },
                    "episodes": list.map { ["id": $0.url.path, "code": $0.code ?? "", "title": $0.title, "size": $0.size] },
                ]
            }
        let films: [[String: Any]] = files.filter { $0.show == nil }
            .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
            .map { ["id": $0.url.path, "title": $0.title, "size": $0.size, "poster": Posters.dataURL(for: $0.tag) ?? NSNull()] }
        return ["shows": shows, "films": films]
    }

    /// The downloaded file at this path; nil for anything outside the library, so the
    /// window can only act on its own files.
    static func file(at path: String) -> LibraryFile? {
        files().first { $0.url.path == path }
    }

    static func play(_ file: LibraryFile) {
        let configuration = NSWorkspace.OpenConfiguration()
        if let iina = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.colliderli.iina") {
            NSWorkspace.shared.open([file.url], withApplicationAt: iina, configuration: configuration)
        } else {
            NSWorkspace.shared.open(file.url)
        }
    }

    static func reveal(_ file: LibraryFile) {
        NSWorkspace.shared.activateFileViewerSelecting([file.url])
    }

    static func trash(_ file: LibraryFile) {
        try? FileManager.default.trashItem(at: file.url, resultingItemURL: nil)
        // Remove the show's folder too once it's empty.
        let folder = file.url.deletingLastPathComponent()
        if file.show != nil,
           let left = try? FileManager.default.contentsOfDirectory(atPath: folder.path),
           left.allSatisfy({ $0.hasPrefix(".") }) {
            try? FileManager.default.removeItem(at: folder)
        }
    }
}

/// Small posters for the library, fetched from Plex when a download is queued and kept in
/// the app's own container, named after the file's tag.
enum Posters {

    private static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Posters", isDirectory: true)
    }

    private static func file(for tag: String) -> URL {
        folder.appendingPathComponent(tag.trimmingCharacters(in: CharacterSet(charactersIn: "{}")))
    }

    /// Fetches the job's poster, from the same server as the file itself.
    static func fetch(for job: DownloadJob) {
        guard let poster = job.poster, let url = URL(string: poster), let media = URL(string: job.url),
              url.scheme == media.scheme, url.host == media.host, url.port == media.port,
              !FileManager.default.fileExists(atPath: file(for: job.tag).path)
        else { return }
        var request = URLRequest(url: url, timeoutInterval: 20)
        if !job.token.isEmpty { request.setValue(job.token, forHTTPHeaderField: "X-Plex-Token") }
        let target = file(for: job.tag)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard let data, data.count < 2_000_000, (response as? HTTPURLResponse)?.statusCode == 200,
                  mimeType(of: data) != nil else { return }
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: target)
        }.resume()
    }

    static func dataURL(for tag: String) -> String? {
        guard let data = try? Data(contentsOf: file(for: tag)), let type = mimeType(of: data) else { return nil }
        return "data:\(type);base64,\(data.base64EncodedString())"
    }

    /// Forget posters of files that are gone.
    static func prune(keeping tags: Set<String>) {
        let keep = Set(tags.map { file(for: $0).lastPathComponent })
        for name in (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [] where !keep.contains(name) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
    }

    private static func mimeType(of data: Data) -> String? {
        if data.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if data.count > 12, data[8..<12].elementsEqual("WEBP".utf8) { return "image/webp" }
        return nil
    }
}
