import Foundation

/// `pose.v1`: body of `POST /analyze/prepare` (DESIGN.md §7.1, schema `shared/schemas/pose.v1.json`).
///
/// Track encoding per frame i: `tUs[i]` exact PTS (µs, Int64, strictly increasing); `kp[i]` 57 ints (19 joints ×
/// x, y ∈ 0…1000 CFS, c ∈ 0…100, `0,0,0` = missing); `bbox[i]` `[x, y, w, h]` in 0…1000; `flags[i]` bit 1 coasted,
/// bit 2 reacquired. Optional fields (`session.level`) are omitted when nil, as the server accepts.
public struct PoseV1: Codable, Sendable, Hashable {
    public static let schemaId = "pose.v1"
    /// Contracts `POSE_V1_MAX_BYTES`.
    public static let maxBytes = 1_200_000
    /// Contracts `MAX_TRACK_FRAMES`.
    public static let maxFrames = 2_048
    public static let analysisRates = [30, 60]

    public var schema: String
    public var analysisId: String
    public var client: Client
    public var session: Session
    public var video: Video
    public var quality: Quality
    public var track: Track

    public init(analysisId: String, client: Client, session: Session, video: Video, quality: Quality, track: Track) {
        self.schema = PoseV1.schemaId
        self.analysisId = analysisId
        self.client = client
        self.session = session
        self.video = video
        self.quality = quality
        self.track = track
    }

    public struct Client: Codable, Sendable, Hashable {
        public var app: String
        public var build: String
        public var os: String
        public var device: String
        public var poseApi: String
        public var algo: String

        public init(app: String, build: String, os: String, device: String, poseApi: String = CoachCoreInfo.visionPoseApi, algo: String = CoachCoreInfo.algoVersion) {
            self.app = app
            self.build = build
            self.os = os
            self.device = device
            self.poseApi = poseApi
            self.algo = algo
        }
    }

    public struct Session: Codable, Sendable, Hashable {
        public var sport: Sport
        public var skill: String
        public var handedness: Handedness
        public var level: Level?
        public var cameraView: CameraView
        public var subject: Subject
        public var subjectConsent: Bool
        /// Subject under 16 → pose-only analysis (requires `subject == .other`).
        public var subjectMinor: Bool
        public var language: Language

        public init(
            sport: Sport,
            skill: String,
            handedness: Handedness,
            level: Level?,
            cameraView: CameraView,
            subject: Subject,
            subjectConsent: Bool,
            subjectMinor: Bool,
            language: Language
        ) {
            self.sport = sport
            self.skill = skill
            self.handedness = handedness
            self.level = level
            self.cameraView = cameraView
            self.subject = subject
            self.subjectConsent = subjectConsent
            self.subjectMinor = subjectMinor
            self.language = language
        }
    }

    public enum Source: String, Codable, Sendable, CaseIterable {
        case recorded, imported
    }

    public struct Segment: Codable, Sendable, Hashable {
        public var startMs: Int64
        public var endMs: Int64

        public init(startMs: Int64, endMs: Int64) {
            self.startMs = startMs
            self.endMs = endMs
        }

        public var durationMs: Int64 { endMs - startMs }
    }

    public struct Display: Codable, Sendable, Hashable {
        public var w: Int
        public var h: Int

        public init(w: Int, h: Int) {
            self.w = w
            self.h = h
        }

        public init(_ size: PixelSize) {
            self.init(w: size.w, h: size.h)
        }

        public var pixelSize: PixelSize { PixelSize(w: w, h: h) }
    }

    public struct Video: Codable, Sendable, Hashable {
        public var source: Source
        /// Duration of the exported clip.
        public var durationMs: Int64
        /// Analysed range on the exported clip's timeline.
        public var segment: Segment
        public var srcFps: Double
        /// 30 or 60.
        public var analysisHz: Int
        /// Composition render size (upright, long edge ≤ 1920).
        public var display: Display
        /// `preferredTransform` det < 0; the server swaps L/R exactly once.
        public var mirrored: Bool

        public init(source: Source, durationMs: Int64, segment: Segment, srcFps: Double, analysisHz: Int, display: Display, mirrored: Bool) {
            self.source = source
            self.durationMs = durationMs
            self.segment = segment
            self.srcFps = srcFps
            self.analysisHz = analysisHz
            self.display = display
            self.mirrored = mirrored
        }
    }

    public struct Quality: Codable, Sendable, Hashable {
        public var framesTotal: Int
        public var framesWithTarget: Int
        public var meanLimbConf: Double
        public var playerHeightFrac: Double
        public var trackResets: Int
        public var ambiguousAtMs: [Int64]

        public init(framesTotal: Int, framesWithTarget: Int, meanLimbConf: Double, playerHeightFrac: Double, trackResets: Int, ambiguousAtMs: [Int64]) {
            self.framesTotal = framesTotal
            self.framesWithTarget = framesWithTarget
            self.meanLimbConf = meanLimbConf
            self.playerHeightFrac = playerHeightFrac
            self.trackResets = trackResets
            self.ambiguousAtMs = ambiguousAtMs
        }

        /// From accumulated stats; ratios are clamped to 0…1 and rounded to 3 decimals to keep the payload tidy.
        public init(stats: QualityStats) {
            func unit(_ v: Double) -> Double {
                guard v.isFinite else { return 0 }
                return (min(max(v, 0), 1) * 1000).rounded() / 1000
            }
            self.init(
                framesTotal: max(0, stats.framesTotal),
                framesWithTarget: max(0, stats.framesWithTarget),
                meanLimbConf: unit(stats.meanLimbConf),
                playerHeightFrac: unit(stats.playerHeightFracMedian),
                trackResets: max(0, stats.trackResets),
                ambiguousAtMs: stats.ambiguousAtMs.map { max(0, $0) }
            )
        }
    }

    public struct Track: Codable, Sendable, Hashable {
        public var jointOrder: [String]
        public var tUs: [Int64]
        public var kp: [[Int]]
        public var bbox: [[Int]]
        public var flags: [Int]

        public init(jointOrder: [String] = Joint.allCases.map(\.rawValue), tUs: [Int64], kp: [[Int]], bbox: [[Int]], flags: [Int]) {
            self.jointOrder = jointOrder
            self.tUs = tUs
            self.kp = kp
            self.bbox = bbox
            self.flags = flags
        }

        public var count: Int { tUs.count }

        /// Joints of frame `i` (dequantized CFS-normalized), empty when out of range.
        public func joints(at i: Int) -> [Joint: Keypoint] {
            guard kp.indices.contains(i) else { return [:] }
            return Quantizer.joints(fromRow: kp[i])
        }
    }
}

// MARK: - Encoding and validation

extension PoseV1 {
    /// Compact, key-sorted JSON (deterministic bytes for a given value).
    public static func makeEncoder(pretty: Bool = false) -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = pretty ? [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
        return e
    }

    /// Encoded body for `prepare`; throws `PoseBuildError.tooLarge` above 1.2 MB.
    public func encodedForUpload() throws -> Data {
        let data = try PoseV1.makeEncoder().encode(self)
        guard data.count <= PoseV1.maxBytes else { throw PoseBuildError.tooLarge(bytes: data.count) }
        return data
    }

    /// Client-side mirror of the server's structural checks (contracts `pose_v1.ts`). Empty when valid.
    public func validate() -> [String] {
        var issues: [String] = []
        if schema != PoseV1.schemaId { issues.append("schema must be \(PoseV1.schemaId)") }
        if !IDs.isLowerCanonical(analysisId) { issues.append("analysisId must be a lowercase canonical uuid") }
        if Sport.of(skill: session.skill) != session.sport { issues.append("skill \(session.skill) is not a \(session.sport.rawValue) skill") }
        if session.subject == .other && !session.subjectConsent { issues.append("subject=other requires consent") }
        if session.subjectMinor && session.subject != .other { issues.append("subjectMinor requires subject=other") }
        if !PoseV1.analysisRates.contains(video.analysisHz) { issues.append("analysisHz must be 30 or 60") }
        if !(video.srcFps.isFinite && video.srcFps > 0) { issues.append("srcFps must be positive") }
        let segMs = video.segment.durationMs
        if segMs < QualityGate.minSegmentMs || segMs > QualityGate.maxSegmentMs { issues.append("segment duration \(segMs) ms outside 3000..32000") }
        if video.segment.endMs > video.durationMs + 50 { issues.append("segment ends after the clip") }
        if video.display.w <= 0 || video.display.h <= 0 { issues.append("display must be positive") }

        let t = track
        if t.jointOrder != Joint.allCases.map(\.rawValue) { issues.append("jointOrder must equal JOINT_ORDER") }
        let n = t.tUs.count
        if n < 2 || n > PoseV1.maxFrames { issues.append("tUs must have 2...\(PoseV1.maxFrames) entries, got \(n)") }
        if t.kp.count != n || t.bbox.count != n || t.flags.count != n { issues.append("kp/bbox/flags length must equal tUs length") }
        if zip(t.tUs, t.tUs.dropFirst()).contains(where: { pair in pair.0 >= pair.1 }) { issues.append("tUs must be strictly increasing") }
        if t.tUs.contains(where: { $0 < 0 }) { issues.append("tUs must be non-negative") }
        if let first = t.tUs.first, let last = t.tUs.last, last - first > QualityGate.maxSegmentMs * 1000 { issues.append("track spans more than 32 s") }
        for (i, row) in t.kp.enumerated() {
            let ok = row.count == Quantizer.valuesPerFrame && row.enumerated().allSatisfy { item in
                item.element >= 0 && item.element <= (item.offset % 3 == 2 ? Quantizer.confMax : Quantizer.cfsMax)
            }
            if !ok {
                issues.append("kp[\(i)] must be 57 ints in range")
                break
            }
        }
        if let i = t.bbox.firstIndex(where: { $0.count != 4 || $0.contains { $0 < 0 || $0 > Quantizer.cfsMax } }) {
            issues.append("bbox[\(i)] must be [x,y,w,h] ints in 0..1000")
        }
        if t.flags.contains(where: { $0 < 0 || $0 > 3 }) { issues.append("flags must be in 0...3") }
        return issues
    }
}
