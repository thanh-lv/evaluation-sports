import Foundation

/// Prepare warning code. Open-ended (a newer server may add codes), so it is a string wrapper with known constants.
public struct PrepareWarning: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    public var description: String { rawValue }

    /// Source < 30 fps or analysis at 30 Hz.
    public static let fpsLow = PrepareWarning(rawValue: "fps_low")
    /// viewGuess confidence < 0.7: ask the user to confirm the view.
    public static let viewLowConfidence = PrepareWarning(rawValue: "view_low_confidence")
    public static let viewMismatch = PrepareWarning(rawValue: "view_mismatch")
    public static let viewNotRecommended = PrepareWarning(rawValue: "view_not_recommended")
    public static let skillMismatchSuspected = PrepareWarning(rawValue: "skill_mismatch_suspected")
    public static let fewStrokes = PrepareWarning(rawValue: "few_strokes")
    public static let playerSmall = PrepareWarning(rawValue: "player_small")
    public static let handednessMismatch = PrepareWarning(rawValue: "handedness_mismatch")
}

/// Phase times of a stroke, µs (snapped to sampled PTS).
public struct StrokePhasesUs: Codable, Sendable, Hashable {
    public var ready: Int64
    public var bsEnd: Int64
    public var contact: Int64
    public var ftStop: Int64

    public init(ready: Int64, bsEnd: Int64, contact: Int64, ftStop: Int64) {
        self.ready = ready
        self.bsEnd = bsEnd
        self.contact = contact
        self.ftStop = ftStop
    }

    public func time(of phase: StrokePhase) -> Int64 {
        switch phase {
        case .ready: return ready
        case .bsEnd: return bsEnd
        case .contact: return contact
        case .ftStop: return ftStop
        }
    }
}

/// `prepare.v1`: 200 response of `POST /analyze/prepare` (DESIGN.md §7.3, `shared/schemas/prepare-response.v1.json`).
/// Server → client: nullable fields decode from `null` or a missing key.
public struct PrepareResponseV1: Codable, Sendable, Hashable {
    public static let schemaId = "prepare.v1"

    public var schema: String
    public var analysisId: String
    /// Always `prepared`.
    public var status: AnalysisStatus
    public var frameMode: FrameMode
    public var warnings: [PrepareWarning]
    public var viewGuess: ViewGuess
    public var handednessSuggestion: Handedness?
    public var strokes: [PreparedStroke]
    public var frameRequests: [FrameRequest]
    public var maxLongEdge: Int
    /// Storage path in `analysis-derived`: `{uid}/{analysisId}/pose.clean.json`.
    public var cleanTrackPath: String
    public var quota: QuotaPreview

    public init(
        analysisId: String,
        status: AnalysisStatus = .prepared,
        frameMode: FrameMode,
        warnings: [PrepareWarning],
        viewGuess: ViewGuess,
        handednessSuggestion: Handedness?,
        strokes: [PreparedStroke],
        frameRequests: [FrameRequest],
        maxLongEdge: Int,
        cleanTrackPath: String,
        quota: QuotaPreview
    ) {
        self.schema = PrepareResponseV1.schemaId
        self.analysisId = analysisId
        self.status = status
        self.frameMode = frameMode
        self.warnings = warnings
        self.viewGuess = viewGuess
        self.handednessSuggestion = handednessSuggestion
        self.strokes = strokes
        self.frameRequests = frameRequests
        self.maxLongEdge = maxLongEdge
        self.cleanTrackPath = cleanTrackPath
        self.quota = quota
    }

    public struct ViewGuess: Codable, Sendable, Hashable {
        public var view: ConfirmedCameraView
        public var confidence: Double

        public init(view: ConfirmedCameraView, confidence: Double) {
            self.view = view
            self.confidence = confidence
        }
    }

    public struct PreparedStroke: Codable, Sendable, Hashable, Identifiable {
        public var id: Int
        public var tStartUs: Int64
        public var tContactUs: Int64
        public var contactIsEstimate: Bool
        public var tEndUs: Int64
        public var phases: StrokePhasesUs
        public var quality: Double
        public var role: StrokeRole?
        /// Thumbnail time for the confirm grid.
        public var thumbTUs: Int64
        /// Unticked on the confirm screen: listed, but no role and no frame requests.
        public var excluded: Bool

        public init(
            id: Int,
            tStartUs: Int64,
            tContactUs: Int64,
            contactIsEstimate: Bool,
            tEndUs: Int64,
            phases: StrokePhasesUs,
            quality: Double,
            role: StrokeRole?,
            thumbTUs: Int64,
            excluded: Bool
        ) {
            self.id = id
            self.tStartUs = tStartUs
            self.tContactUs = tContactUs
            self.contactIsEstimate = contactIsEstimate
            self.tEndUs = tEndUs
            self.phases = phases
            self.quality = quality
            self.role = role
            self.thumbTUs = thumbTUs
            self.excluded = excluded
        }
    }

    public struct FrameRequest: Codable, Sendable, Hashable {
        public var frameId: FrameId
        public var strokeId: Int
        public var phase: FramePhase
        /// A sampled PTS from the pose track; render at ±0.45 frame tolerance.
        public var tUs: Int64
        /// Normalized crop in display space (top-left origin).
        public var crop: Rect
        public var upload: Bool

        public init(frameId: FrameId, strokeId: Int, phase: FramePhase, tUs: Int64, crop: Rect, upload: Bool) {
            self.frameId = frameId
            self.strokeId = strokeId
            self.phase = phase
            self.tUs = tUs
            self.crop = crop
            self.upload = upload
        }
    }

    public struct QuotaPreview: Codable, Sendable, Hashable {
        public var tier: Tier
        public var remaining: Int
        public var nextKind: AnalysisKind
        /// ISO 8601 with offset; nil for the trial (no reset).
        public var resetsAt: String?

        public init(tier: Tier, remaining: Int, nextKind: AnalysisKind, resetsAt: String?) {
            self.tier = tier
            self.remaining = remaining
            self.nextKind = nextKind
            self.resetsAt = resetsAt
        }
    }

    /// Frames to upload (F1–F5 in `frames` mode; none in `pose_only`).
    public var uploadRequests: [FrameRequest] { frameRequests.filter(\.upload) }

    public func stroke(id: Int) -> PreparedStroke? { strokes.first { $0.id == id } }
}

public typealias PreparedStroke = PrepareResponseV1.PreparedStroke
public typealias FrameRequest = PrepareResponseV1.FrameRequest
public typealias QuotaPreview = PrepareResponseV1.QuotaPreview
/// Contract name for frame-request crops (`{x, y, w, h}`, 0…1, top-left origin).
public typealias NormRect = Rect
