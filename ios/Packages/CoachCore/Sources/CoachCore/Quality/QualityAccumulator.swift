import Foundation

/// Clip-level quality summary; maps 1:1 onto `pose.v1` `quality` (see `PoseV1.Quality.init(stats:)`).
public struct QualityStats: Codable, Sendable, Hashable {
    public var framesTotal: Int
    public var framesWithTarget: Int
    /// Mean limb-joint confidence over frames with a target (a missing limb joint counts as 0).
    public var meanLimbConf: Double
    /// Median target box height as a fraction of frame height, over frames with a target.
    public var playerHeightFracMedian: Double
    /// Share of frames without an observed target, 0…1.
    public var missingPct: Double
    public var trackResets: Int
    /// Asset-timeline ms at the start of each ambiguous run.
    public var ambiguousAtMs: [Int64]

    public init(
        framesTotal: Int,
        framesWithTarget: Int,
        meanLimbConf: Double,
        playerHeightFracMedian: Double,
        missingPct: Double,
        trackResets: Int,
        ambiguousAtMs: [Int64]
    ) {
        self.framesTotal = framesTotal
        self.framesWithTarget = framesWithTarget
        self.meanLimbConf = meanLimbConf
        self.playerHeightFracMedian = playerHeightFracMedian
        self.missingPct = missingPct
        self.trackResets = trackResets
        self.ambiguousAtMs = ambiguousAtMs
    }

    /// Share of frames with a target, 0…1 (0 for an empty clip).
    public var presence: Double { framesTotal > 0 ? Double(framesWithTarget) / Double(framesTotal) : 0 }
}

/// Accumulates per-frame tracking results into `QualityStats` (DESIGN.md §5.3 `Quality/`).
///
/// Counts every sampled frame of the analysed segment, including frames before the player is selected.
public struct QualityAccumulator: Codable, Sendable, Hashable {
    public private(set) var framesTotal = 0
    public private(set) var framesWithTarget = 0
    public private(set) var limbConfSum = 0.0
    public private(set) var heights: [Double] = []
    public private(set) var trackResets = 0
    public private(set) var ambiguousAtMs: [Int64] = []
    private var inAmbiguousRun = false

    public init() {}

    /// Records one sampled frame. `target` is the matched candidate (nil when coasting, lost or not yet selected).
    public mutating func add(tUs: Int64, target: PersonCandidate?, reacquired: Bool = false, ambiguous: Bool = false) {
        framesTotal += 1
        if reacquired { trackResets += 1 }
        if ambiguous {
            // One entry per contiguous ambiguous run keeps the payload small.
            if !inAmbiguousRun { ambiguousAtMs.append(max(0, Timebase.milliseconds(fromMicroseconds: tUs))) }
            inAmbiguousRun = true
        } else {
            inAmbiguousRun = false
        }
        guard let target else { return }
        framesWithTarget += 1
        let limbSum = Joint.limbs.reduce(0.0) { $0 + min(max(target.joints[$1]?.c ?? 0, 0), 1) }
        limbConfSum += limbSum / Double(Joint.limbs.count)
        let h = target.bbox.h
        if h.isFinite { heights.append(min(max(h, 0), 1)) }
    }

    /// Convenience for the pipeline: records a tracker step with the candidates it was computed from.
    public mutating func add(tUs: Int64, step: TrackStep, candidates: [PersonCandidate]) {
        let target = step.index.flatMap { $0 >= 0 && $0 < candidates.count ? candidates[$0] : nil }
        add(tUs: tUs, target: target, reacquired: step.reacquired, ambiguous: step.ambiguous)
    }

    public var stats: QualityStats {
        QualityStats(
            framesTotal: framesTotal,
            framesWithTarget: framesWithTarget,
            meanLimbConf: framesWithTarget > 0 ? limbConfSum / Double(framesWithTarget) : 0,
            playerHeightFracMedian: QualityAccumulator.median(heights),
            missingPct: framesTotal > 0 ? Double(framesTotal - framesWithTarget) / Double(framesTotal) : 1,
            trackResets: trackResets,
            ambiguousAtMs: ambiguousAtMs
        )
    }

    /// Median (mean of the two middle values for an even count); 0 for an empty list.
    public static func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let s = values.sorted()
        let mid = s.count / 2
        return s.count % 2 == 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }
}
