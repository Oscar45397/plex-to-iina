//
//  DownloadFolder.swift
//  Shared by the app, which downloads the files for the extension's Download button, and
//  the extension handler, which checks what's already there before it asks the app.
//
//  Files go to ~/Downloads/Plex to IINA/, named by the extension (download.js):
//  "<Show>/S01E02 - Title {plex-<server>-<ratingKey>}.mkv" or "Title (Year) {plex-…}.mkv".
//  The tag identifies the item; the IINA plugin reads it to sync progress with Plex.
//

import Foundation

enum DownloadFolder {

    static let name = "Plex to IINA"

    // Containers that Plex serves as video. Anything else is refused, so a bad request
    // can't put, say, an app into the Downloads folder.
    private static let videoExtensions: Set<String> = [
        "mkv", "mp4", "m4v", "mov", "avi", "ts", "m2ts", "mts", "webm", "wmv", "mpg", "mpeg",
        "vob", "flv", "ogv", "3gp", "asf", "divx",
    ]

    /// ~/Downloads/Plex to IINA. Inside the sandbox, the app's own Downloads folder links to
    /// the real one; use the real path so Finder shows where the files are.
    static var url: URL {
        downloads.appendingPathComponent(name, isDirectory: true)
    }

    static var downloads: URL {
        let home = getpwuid(getuid()).map { String(cString: $0.pointee.pw_dir) } ?? NSHomeDirectory()
        return URL(fileURLWithPath: home, isDirectory: true).appendingPathComponent("Downloads", isDirectory: true)
    }

    /// "{plex-1a2b3c4d-4242}" from a file name that ends in that tag and an extension.
    static func tag(in fileName: String) -> String? {
        guard let range = fileName.range(of: #"\{plex-[0-9a-f]{8}-[0-9]+\}(?=\.[A-Za-z0-9]+$)"#, options: .regularExpression) else {
            return nil
        }
        return String(fileName[range])
    }

    /// Tags of the files already in the folder or one folder down (shows).
    static func existingTags() -> Set<String> {
        let files = FileManager.default.enumerator(
            at: url,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        )
        var tags = Set<String>()
        while let file = files?.nextObject() as? URL {
            if let tag = tag(in: file.lastPathComponent) { tags.insert(tag) }
        }
        return tags
    }

    /// Where a file named by the extension goes, or nil if the name isn't one it makes:
    /// "Plex to IINA/<name>" or "Plex to IINA/<show>/<name>", ending in a tag and a video
    /// extension, with no hidden or parent-folder parts.
    static func destination(for path: String) -> URL? {
        let parts = path.components(separatedBy: "/")
        guard (2...3).contains(parts.count), parts[0] == name,
              parts.dropFirst().allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") && !$0.contains(":") }),
              let fileName = parts.last, tag(in: fileName) != nil,
              videoExtensions.contains((fileName as NSString).pathExtension.lowercased())
        else { return nil }
        return parts.dropFirst().reduce(url) { $0.appendingPathComponent($1) }
    }

    /// Space free for files the user asked for, which includes space macOS can free up.
    static func freeBytes() -> Int64? {
        let values = try? downloads.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }
}
