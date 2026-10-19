import Foundation

/// Local video housekeeping (DESIGN.md D16): videos older than 60 days are deleted automatically (the app shows a
/// notice), "delete local videos" in Settings, storage usage, and the free-space check before recording or importing.
/// Results, key frames and pose files stay; only `source.mov` files go.
///
/// Required-reason APIs (PrivacyInfo.xcprivacy): file creation dates (`C617.1`, files inside the app container) and
/// volume capacity (`E174.1`, free space before writing a video).
struct StorageMaintenance: Sendable {
    static let maxVideoAgeDays = 60
    /// Below this, recording and importing ask the user to free space first.
    static let minimumFreeBytes: Int64 = 500 * 1024 * 1024

    struct Usage: Sendable, Equatable {
        var videoBytes: Int64
        var totalBytes: Int64
        var videoCount: Int
    }

    let store: any LocalAnalysisStore
    let clock: any AppClock

    /// Deletes source videos older than `maxVideoAgeDays`. Returns how many were removed (show a notice when > 0).
    @discardableResult
    func removeExpiredVideos() async -> Int {
        let now = clock.now()
        let cutoff = now.addingTimeInterval(-Double(Self.maxVideoAgeDays) * 86_400)
        var removed = 0
        for record in await store.all() where record.sourceVideo != nil {
            guard let name = record.sourceVideo, let url = try? await store.fileURL(id: record.id, name: name) else { continue }
            let created = Self.creationDate(of: url) ?? record.createdAt
            guard created < cutoff else { continue }
            if await removeVideo(of: record, at: url, now: now) { removed += 1 }
        }
        return removed
    }

    /// Settings › Storage › "Delete local videos". Returns how many were removed.
    @discardableResult
    func deleteAllVideos() async -> Int {
        let now = clock.now()
        var removed = 0
        for record in await store.all() where record.sourceVideo != nil {
            guard let name = record.sourceVideo, let url = try? await store.fileURL(id: record.id, name: name) else { continue }
            if await removeVideo(of: record, at: url, now: now) { removed += 1 }
        }
        return removed
    }

    /// Bytes used under `Analyses/` and by the source videos.
    func usage() async -> Usage {
        var usage = Usage(videoBytes: 0, totalBytes: 0, videoCount: 0)
        guard let root = try? await store.rootDirectory() else { return usage }
        usage.totalBytes = Self.directorySize(root)
        for record in await store.all() {
            guard let name = record.sourceVideo, let url = try? await store.fileURL(id: record.id, name: name) else { continue }
            if let size = Self.fileSize(url) {
                usage.videoBytes += size
                usage.videoCount += 1
            }
        }
        return usage
    }

    /// Free space for important data on the app's volume (nil when unknown).
    static func availableCapacity() -> Int64? {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        #if os(iOS) || os(macOS) || os(visionOS)
        if let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let capacity = values.volumeAvailableCapacityForImportantUsage {
            return capacity
        }
        #endif
        if let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityKey]),
           let capacity = values.volumeAvailableCapacity {
            return Int64(capacity)
        }
        return nil
    }

    /// True when there is room for a new video (unknown counts as enough).
    static func hasRoomForVideo() -> Bool {
        guard let capacity = availableCapacity() else { return true }
        return capacity >= minimumFreeBytes
    }

    // MARK: - Private

    private func removeVideo(of record: LocalAnalysisRecord, at url: URL, now: Date) async -> Bool {
        if FileManager.default.fileExists(atPath: url.path) {
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                return false
            }
        }
        _ = try? await store.update(id: record.id) { record in
            record.sourceVideo = nil
            record.sourceRemovedAt = now
        }
        return true
    }

    static func creationDate(of url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate
    }

    static func fileSize(_ url: URL) -> Int64? {
        guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize else { return nil }
        return Int64(size)
    }

    static func directorySize(_ url: URL) -> Int64 {
        guard let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else {
            return 0
        }
        var total: Int64 = 0
        for case let file as URL in enumerator {
            total += fileSize(file) ?? 0
        }
        return total
    }
}
