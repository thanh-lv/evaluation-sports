import CoachCore
import Foundation

/// One analysis as kept on this iPhone (DESIGN.md §5.2 Local). File names are relative to the analysis folder
/// `Application Support/Analyses/<id>/`; use `LocalAnalysisStore.fileURL(id:name:)` to resolve them.
struct LocalAnalysisRecord: Codable, Sendable, Hashable, Identifiable {
    /// Where the local pipeline stands. `uploading` and `submitted` resume on launch, foreground or network change.
    enum Stage: String, Codable, Sendable, CaseIterable {
        /// Video saved (recorded, or imported and exported), nothing sent yet.
        case captured
        /// `prepare` answered; strokes and frame requests are known.
        case prepared
        /// Key frames rendered and saved locally; upload pending or in progress.
        case uploading
        /// `submit` accepted; the server job is queued or running.
        case submitted
        /// A result is cached (`hasResult`).
        case finished
        /// Rejected by the quality gate, `prepare` or the coach (no quota used).
        case rejected
        case failed
    }

    /// Lowercase analysis id (`IDs.lower`).
    var id: String
    var createdAt: Date
    var updatedAt: Date
    var sport: Sport?
    var skill: String?
    var subject: Subject?
    var frameMode: FrameMode?
    var stage: Stage
    var serverStatus: AnalysisStatus?
    /// Contracts error or rejection code of a rejected/failed analysis.
    var failureCode: String?
    /// `source.mov` (in-app recording, or the passthrough export of an import). Nil once deleted.
    var sourceVideo: String?
    /// When the video was removed (60-day clean-up or "delete local videos").
    var sourceRemovedAt: Date?
    var segmentStartUs: Int64?
    var segmentEndUs: Int64?
    /// Rendered key frames by `FrameId` raw value (`F1`…`F5` unblurred originals, `L1`…`L4`), file names.
    var keyFrames: [String: String]
    /// Stroke thumbnails for "Xác nhận cú đánh", by stroke id (as a string), file names.
    var strokeThumbnails: [String: String]
    var hasResult: Bool
    var hasCleanTrack: Bool
    /// Summary of the cached result, for Home and History without decoding the whole result.
    var displayScore: Int?
    var partial: Bool?
    var heroTitle: String?
    /// Set while an upload or submit is waiting to be resumed.
    var pendingSince: Date?
    /// Feature-specific values (pipeline checkpoints, flags). Keys are owned by the feature that writes them.
    var extra: [String: JSONValue]

    init(
        id: String,
        createdAt: Date,
        sport: Sport? = nil,
        skill: String? = nil,
        subject: Subject? = nil,
        stage: Stage = .captured
    ) {
        self.id = IDs.lower(id) ?? id.lowercased()
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.sport = sport
        self.skill = skill
        self.subject = subject
        self.frameMode = nil
        self.stage = stage
        self.serverStatus = nil
        self.failureCode = nil
        self.sourceVideo = nil
        self.sourceRemovedAt = nil
        self.segmentStartUs = nil
        self.segmentEndUs = nil
        self.keyFrames = [:]
        self.strokeThumbnails = [:]
        self.hasResult = false
        self.hasCleanTrack = false
        self.displayScore = nil
        self.partial = nil
        self.heroTitle = nil
        self.pendingSince = nil
        self.extra = [:]
    }

    var isPending: Bool { pendingSince != nil || stage == .uploading || stage == .submitted }
    var hasVideo: Bool { sourceVideo != nil }
}

/// The on-device index of analyses plus their files (DESIGN.md §5.2 Local, D16). The `Analyses/` folder is excluded
/// from iCloud backup. Implemented by `FileLocalAnalysisStore`; tests use it with a temporary root.
protocol LocalAnalysisStore: Sendable {
    /// `Application Support/Analyses`, created on first use and excluded from backup.
    func rootDirectory() async throws -> URL
    /// The folder of one analysis (created if needed).
    func directory(for id: String) async throws -> URL
    /// Absolute URL of a file inside an analysis folder (`source.mov`, `frames/F1.jpg`, …). Does not create it.
    func fileURL(id: String, name: String) async throws -> URL

    /// Every record, newest first.
    func all() async -> [LocalAnalysisRecord]
    func record(id: String) async -> LocalAnalysisRecord?
    /// Inserts or replaces a record (sets `updatedAt`).
    func save(_ record: LocalAnalysisRecord) async throws
    /// Applies `change` to an existing record and saves it; returns nil when there is no such record.
    @discardableResult
    func update(id: String, _ change: @Sendable (inout LocalAnalysisRecord) -> Void) async throws -> LocalAnalysisRecord?

    /// Caches the redacted result (`result.json`) and its summary in the record.
    func saveResult(_ result: CoachResultV1, id: String) async throws
    func cachedResult(id: String) async -> CoachResultV1?
    /// Caches `pose.clean.json` (raw bytes as downloaded).
    func saveCleanTrack(_ data: Data, id: String) async throws
    func cachedCleanTrack(id: String) async -> CleanTrackV1?

    /// Removes the record and its folder.
    func delete(id: String) async throws
    /// Records with an upload or submit to resume.
    func pending() async -> [LocalAnalysisRecord]
    /// The newest record with a cached result (Home "last result" card).
    func latestWithResult() async -> LocalAnalysisRecord?
}

/// JSON index (`Analyses/index.json`) plus one folder per analysis.
actor FileLocalAnalysisStore: LocalAnalysisStore {
    static let resultFileName = "result.json"
    static let cleanTrackFileName = "pose.clean.json"
    static let indexFileName = "index.json"

    private let root: URL
    private let fileManager = FileManager.default
    private var records: [String: LocalAnalysisRecord]?

    /// `root` defaults to `Application Support/Analyses`.
    init(root: URL? = nil) {
        if let root {
            self.root = root
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            self.root = base.appendingPathComponent("Analyses", isDirectory: true)
        }
    }

    func rootDirectory() throws -> URL {
        try ensureRoot()
        return root
    }

    func directory(for id: String) throws -> URL {
        let folder = try folderURL(id)
        if !fileManager.fileExists(atPath: folder.path) {
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        return folder
    }

    func fileURL(id: String, name: String) throws -> URL {
        guard !name.contains(".."), !name.hasPrefix("/") else {
            throw AppError.unknown("invalid local file name \(name)")
        }
        return try folderURL(id).appendingPathComponent(name)
    }

    func all() -> [LocalAnalysisRecord] {
        loadIndex().values.sorted { lhs, rhs in
            lhs.createdAt != rhs.createdAt ? lhs.createdAt > rhs.createdAt : lhs.id < rhs.id
        }
    }

    func record(id: String) -> LocalAnalysisRecord? {
        loadIndex()[normalized(id)]
    }

    func save(_ record: LocalAnalysisRecord) throws {
        var index = loadIndex()
        var copy = record
        copy.id = normalized(record.id)
        copy.updatedAt = Date()
        index[copy.id] = copy
        try writeIndex(index)
    }

    @discardableResult
    func update(id: String, _ change: @Sendable (inout LocalAnalysisRecord) -> Void) throws -> LocalAnalysisRecord? {
        var index = loadIndex()
        let key = normalized(id)
        guard var record = index[key] else { return nil }
        change(&record)
        record.id = key
        record.updatedAt = Date()
        index[key] = record
        try writeIndex(index)
        return record
    }

    func saveResult(_ result: CoachResultV1, id: String) throws {
        let folder = try directory(for: id)
        let data = try JSONEncoder().encode(result)
        try data.write(to: folder.appendingPathComponent(Self.resultFileName), options: .atomic)
        var index = loadIndex()
        let key = normalized(id)
        var record = index[key] ?? LocalAnalysisRecord(id: key, createdAt: Date(), sport: result.sport, skill: result.skill)
        record.hasResult = true
        record.sport = record.sport ?? result.sport
        record.skill = record.skill ?? result.skill
        record.displayScore = result.overall.displayScore
        record.partial = result.overall.partial
        record.heroTitle = result.hero?.title
        record.serverStatus = .succeeded
        record.stage = .finished
        record.pendingSince = nil
        record.updatedAt = Date()
        index[key] = record
        try writeIndex(index)
    }

    func cachedResult(id: String) -> CoachResultV1? {
        guard let url = try? fileURL(id: id, name: Self.resultFileName),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(CoachResultV1.self, from: data)
    }

    func saveCleanTrack(_ data: Data, id: String) throws {
        let folder = try directory(for: id)
        try data.write(to: folder.appendingPathComponent(Self.cleanTrackFileName), options: .atomic)
        _ = try update(id: id) { $0.hasCleanTrack = true }
    }

    func cachedCleanTrack(id: String) -> CleanTrackV1? {
        guard let url = try? fileURL(id: id, name: Self.cleanTrackFileName),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? CleanTrackV1.decode(data)
    }

    func delete(id: String) throws {
        var index = loadIndex()
        let key = normalized(id)
        index[key] = nil
        try writeIndex(index)
        let folder = try folderURL(key)
        if fileManager.fileExists(atPath: folder.path) {
            try fileManager.removeItem(at: folder)
        }
    }

    func pending() -> [LocalAnalysisRecord] {
        all().filter(\.isPending)
    }

    func latestWithResult() -> LocalAnalysisRecord? {
        all().first(where: \.hasResult)
    }

    // MARK: - Private

    private func normalized(_ id: String) -> String {
        IDs.lower(id) ?? id.lowercased()
    }

    private func folderURL(_ id: String) throws -> URL {
        guard let key = IDs.lower(id) else { throw AppError.unknown("invalid analysis id \(id)") }
        try ensureRoot()
        return root.appendingPathComponent(key, isDirectory: true)
    }

    private func ensureRoot() throws {
        if !fileManager.fileExists(atPath: root.path) {
            try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        }
        try Self.excludeFromBackup(root)
    }

    /// DESIGN.md D16: local videos and frames never go to iCloud backups.
    static func excludeFromBackup(_ url: URL) throws {
        #if os(iOS) || os(macOS) || os(tvOS) || os(watchOS) || os(visionOS)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = url
        try mutable.setResourceValues(values)
        #endif
    }

    private func loadIndex() -> [String: LocalAnalysisRecord] {
        if let records { return records }
        let url = root.appendingPathComponent(Self.indexFileName)
        var loaded: [String: LocalAnalysisRecord] = [:]
        if let data = try? Data(contentsOf: url) {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            if let list = try? decoder.decode([LocalAnalysisRecord].self, from: data) {
                for record in list { loaded[record.id] = record }
            }
        }
        records = loaded
        return loaded
    }

    private func writeIndex(_ index: [String: LocalAnalysisRecord]) throws {
        try ensureRoot()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let list = index.values.sorted { $0.id < $1.id }
        let data = try encoder.encode(list)
        try data.write(to: root.appendingPathComponent(Self.indexFileName), options: .atomic)
        records = index
    }
}
