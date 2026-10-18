import Foundation

/// `clean-track.v1` (`pose.clean.json` in Storage `analysis-derived/{uid}/{analysisId}/`), used by the skeleton
/// overlay and the Premium player (`shared/schemas/clean-track.v1.json`).
///
/// Uniform grid `tUs[i] = t0Us + round(i·1e6 / analysisHz)`. `kp[i]` is 57 numbers in `jointOrder`: x, y float CFS
/// 0…1000, c int 0…100; `0,0,0` = missing. `interp[i]` bit j set ⇔ joint j was gap-filled. L/R labels are already
/// corrected, so `mirrored` is informational only.
public struct CleanTrackV1: Codable, Sendable, Hashable {
    public static let schemaId = "clean-track.v1"

    public var schema: String
    public var analysisId: String
    public var algoVersion: String
    public var analysisHz: Int
    public var display: PoseV1.Display
    public var mirrored: Bool
    /// Torso unit as a fraction of frame height.
    public var torsoT: Double
    public var jointOrder: [String]
    public var t0Us: Int64
    public var tUs: [Int64]
    public var kp: [[Double]]
    public var interp: [Int]
    public var strokes: [Stroke]

    public init(
        analysisId: String,
        algoVersion: String,
        analysisHz: Int,
        display: PoseV1.Display,
        mirrored: Bool,
        torsoT: Double,
        jointOrder: [String] = Joint.allCases.map(\.rawValue),
        t0Us: Int64,
        tUs: [Int64],
        kp: [[Double]],
        interp: [Int],
        strokes: [Stroke]
    ) {
        self.schema = CleanTrackV1.schemaId
        self.analysisId = analysisId
        self.algoVersion = algoVersion
        self.analysisHz = analysisHz
        self.display = display
        self.mirrored = mirrored
        self.torsoT = torsoT
        self.jointOrder = jointOrder
        self.t0Us = t0Us
        self.tUs = tUs
        self.kp = kp
        self.interp = interp
        self.strokes = strokes
    }

    /// All engine phases (µs); `swingStart` / `recovery` may be nil when out of range.
    public struct Phases: Codable, Sendable, Hashable {
        public var swingStart: Int64?
        public var ready: Int64
        public var bsEnd: Int64
        public var contact: Int64
        public var ftStop: Int64
        public var recovery: Int64?

        public init(swingStart: Int64?, ready: Int64, bsEnd: Int64, contact: Int64, ftStop: Int64, recovery: Int64?) {
            self.swingStart = swingStart
            self.ready = ready
            self.bsEnd = bsEnd
            self.contact = contact
            self.ftStop = ftStop
            self.recovery = recovery
        }
    }

    public struct Stroke: Codable, Sendable, Hashable, Identifiable {
        public var id: Int
        public var tStartUs: Int64
        public var tContactUs: Int64
        public var contactIsEstimate: Bool
        public var tEndUs: Int64
        public var phases: Phases
        public var role: StrokeRole?
        public var excluded: Bool

        public init(id: Int, tStartUs: Int64, tContactUs: Int64, contactIsEstimate: Bool, tEndUs: Int64, phases: Phases, role: StrokeRole?, excluded: Bool) {
            self.id = id
            self.tStartUs = tStartUs
            self.tContactUs = tContactUs
            self.contactIsEstimate = contactIsEstimate
            self.tEndUs = tEndUs
            self.phases = phases
            self.role = role
            self.excluded = excluded
        }
    }

    /// Whether joint `joint` was gap-filled at frame `i`.
    public func isInterpolated(frame i: Int, joint: Joint) -> Bool {
        guard interp.indices.contains(i) else { return false }
        return (interp[i] >> joint.index) & 1 == 1
    }

    /// Joints of frame `i` (CFS-normalized), empty when out of range.
    public func joints(at i: Int) -> [Joint: Keypoint] {
        guard kp.indices.contains(i) else { return [:] }
        return Quantizer.joints(fromRow: kp[i])
    }
}
