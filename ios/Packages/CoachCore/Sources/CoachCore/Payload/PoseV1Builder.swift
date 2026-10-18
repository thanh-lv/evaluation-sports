import Foundation

public enum PoseBuildError: Error, Sendable, Hashable {
    case invalidAnalysisId(String)
    case tooFewFrames(count: Int)
    case tooManyFrames(count: Int)
    /// No frame ever had a target box (nothing was selected or tracked).
    case noTargetBox
    case tooLarge(bytes: Int)
}

/// Accumulates sampled frames and builds a `pose.v1` document (DESIGN.md §5.3 `Payload/`).
///
/// Used identically by the app pipeline and PoseDump. Frames are appended in PTS order; a frame whose PTS does not
/// increase is dropped. Frames without an observed target carry `0,0,0` joints, the `coasted` flag and a box
/// back-filled from the nearest known box (previous, else next), because the server requires a box on every frame.
public struct PoseV1Builder: Codable, Sendable, Hashable {
    public struct Frame: Codable, Sendable, Hashable {
        public var tUs: Int64
        /// 57 quantized values.
        public var kp: [Int]
        /// Observed or predicted target box (CFS); nil when unknown.
        public var box: Rect?
        public var flags: TrackFlags

        public init(tUs: Int64, kp: [Int], box: Rect?, flags: TrackFlags) {
            self.tUs = tUs
            self.kp = kp
            self.box = box
            self.flags = flags
        }
    }

    public let analysisId: String
    public var client: PoseV1.Client
    public var session: PoseV1.Session
    public var video: PoseV1.Video
    public private(set) var frames: [Frame] = []

    /// - Parameter analysisId: any-case UUID text; stored lowercase.
    public init(analysisId: String, client: PoseV1.Client, session: PoseV1.Session, video: PoseV1.Video) throws {
        guard let lower = IDs.lower(analysisId) else { throw PoseBuildError.invalidAnalysisId(analysisId) }
        self.analysisId = lower
        self.client = client
        self.session = session
        self.video = video
    }

    public init(analysisId: UUID, client: PoseV1.Client, session: PoseV1.Session, video: PoseV1.Video) {
        self.analysisId = IDs.lower(analysisId)
        self.client = client
        self.session = session
        self.video = video
    }

    public var count: Int { frames.count }

    /// Appends one sampled frame. Returns false (and drops it) when `tUs` does not increase or is negative.
    @discardableResult
    public mutating func append(tUs: Int64, target: PersonCandidate?, box: Rect?, flags: TrackFlags) -> Bool {
        guard tUs >= 0 else { return false }
        if let last = frames.last, tUs <= last.tUs { return false }
        // A box that is non-finite or empty inside the frame counts as unknown (back-filled at build time), so the
        // wire never carries a `w = 0` / `h = 0` box.
        let observedBox = box.flatMap { b -> Rect? in
            guard b.isFinite else { return nil }
            let q = Quantizer.box(b)
            return q[2] > 0 && q[3] > 0 ? b : nil
        }
        var f = flags
        if target == nil { f.insert(.coasted) }
        frames.append(Frame(tUs: tUs, kp: Quantizer.frame(target?.joints), box: observedBox, flags: f))
        return true
    }

    /// Appends a tracked frame from a `Tracker.step` result and the candidates it was computed from.
    @discardableResult
    public mutating func append(tUs: Int64, step: TrackStep, candidates: [PersonCandidate]) -> Bool {
        let target = step.index.flatMap { $0 >= 0 && $0 < candidates.count ? candidates[$0] : nil }
        return append(tUs: tUs, target: target, box: target?.bbox ?? step.box, flags: step.flags)
    }

    /// Appends a frame with no target (before selection, or when tracking has not started).
    @discardableResult
    public mutating func appendMissing(tUs: Int64) -> Bool {
        append(tUs: tUs, target: nil, box: nil, flags: .coasted)
    }

    /// Builds the document. Throws when there are fewer than 2 or more than 2048 frames, or no box at all.
    public func build(quality: QualityStats) throws -> PoseV1 {
        let n = frames.count
        guard n >= 2 else { throw PoseBuildError.tooFewFrames(count: n) }
        guard n <= PoseV1.maxFrames else { throw PoseBuildError.tooManyFrames(count: n) }
        guard let boxes = PoseV1Builder.backfilledBoxes(frames.map(\.box)) else { throw PoseBuildError.noTargetBox }

        let track = PoseV1.Track(
            tUs: frames.map(\.tUs),
            kp: frames.map(\.kp),
            bbox: boxes.map { Quantizer.box($0) },
            flags: frames.map(\.flags.rawValue)
        )
        return PoseV1(analysisId: analysisId, client: client, session: session, video: video, quality: PoseV1.Quality(stats: quality), track: track)
    }

    /// Fills nil boxes with the previous known box, or the next one at the start; nil when every box is nil.
    static func backfilledBoxes(_ boxes: [Rect?]) -> [Rect]? {
        guard let firstKnown = boxes.first(where: { $0 != nil }) ?? nil else { return nil }
        var out: [Rect] = []
        out.reserveCapacity(boxes.count)
        var last = firstKnown
        for b in boxes {
            if let b { last = b }
            out.append(last)
        }
        return out
    }
}
