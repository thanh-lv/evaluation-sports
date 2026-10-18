import Foundation

/// Per-frame payload flag bits (contracts `FLAG_COASTED` = 1, `FLAG_REACQUIRED` = 2).
public struct TrackFlags: OptionSet, Codable, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    /// No observed target this frame (predicted while coasting, or lost).
    public static let coasted = TrackFlags(rawValue: 1)
    /// Target re-acquired after the track was lost.
    public static let reacquired = TrackFlags(rawValue: 2)
}

/// Result of one `Tracker.step`.
public struct TrackStep: Sendable, Hashable {
    /// Index of the matched candidate in the array passed to `step`; nil when coasting or lost.
    public var index: Int?
    /// Matched box; the predicted box (clipped to the frame) while coasting; nil when lost.
    public var box: Rect?
    public var coasted: Bool
    public var reacquired: Bool
    /// Two plausible candidates were within 15 % cost of each other (e.g. doubles crossings).
    public var ambiguous: Bool
    /// The coast window (0.5 s) was exceeded and no candidate could be re-acquired.
    public var lost: Bool
    /// ROI (CFS) for the NEXT frame's pose request.
    public var roi: Rect

    public init(index: Int?, box: Rect?, coasted: Bool, reacquired: Bool, ambiguous: Bool, lost: Bool, roi: Rect) {
        self.index = index
        self.box = box
        self.coasted = coasted
        self.reacquired = reacquired
        self.ambiguous = ambiguous
        self.lost = lost
        self.roi = roi
    }

    public var flags: TrackFlags {
        var f: TrackFlags = []
        if index == nil { f.insert(.coasted) }
        if reacquired { f.insert(.reacquired) }
        return f
    }
}

/// Single-target tracker (DESIGN.md §5.4 step 5, unchanged from v1.0, plus ROI crop-follow).
///
/// - Prediction: constant velocity of the box centre from the last two matches (size kept).
/// - Cost: `(1 − IoU) + 0.5·|Δc|/diag(pred) + 0.2·|ln(area_c / area_pred)|`, distances aspect-corrected.
/// - Gate: IoU > 0.1 or |Δc| < 1.5 torso.
/// - Coast ≤ 0.5 s (frames flagged coasted, joints missing); after that the track is lost and the candidate nearest
///   the last position with torso size within ±30 % is re-acquired (flagged `reacquired`).
/// - Ambiguity: best two gated costs within 15 %.
/// - ROI for the next frame: matched box ×2, at least 40 % of frame height, kept inside the frame; the full frame
///   while coasting or lost.
///
/// Value type and `Codable`, so the pipeline can checkpoint it when the app goes to the background.
public struct Tracker: Codable, Sendable, Hashable {
    public enum State: String, Codable, Sendable {
        case tracking, coasting, lost
    }

    public static let coastUs: Int64 = 500_000
    public static let gateMinIoU = 0.1
    public static let gateTorsoMultiple = 1.5
    public static let reacquireTolerance = 0.3
    public static let ambiguityMargin = 0.15
    public static let roiExpansion = 2.0
    public static let roiMinHeight = 0.4
    /// EMA weight of a new torso measurement.
    static let torsoSmoothing = 0.2

    public let aspect: Double
    public private(set) var state: State
    public private(set) var lastBox: Rect
    public private(set) var lastUs: Int64
    public private(set) var previousBox: Rect?
    public private(set) var previousUs: Int64?
    /// Tracked torso length in frame-height units.
    public private(set) var torso: Double
    /// ROI for the next frame (CFS).
    public private(set) var roi: Rect
    /// Number of re-acquisitions after a loss.
    public private(set) var resets: Int

    /// Starts a track on the selected candidate at `tUs`.
    public init(initial: PersonCandidate, tUs: Int64, aspect: Double) {
        self.aspect = (aspect.isFinite && aspect > 0) ? aspect : 1
        state = .tracking
        lastBox = initial.bbox
        lastUs = tUs
        previousBox = nil
        previousUs = nil
        torso = Tracker.positiveTorso(initial.torso, fallbackBox: initial.bbox)
        roi = Tracker.roi(around: initial.bbox)
        resets = 0
    }

    /// Constant-velocity prediction of the target box at `tUs` (extrapolation capped at the coast window).
    public func predictedBox(atUs tUs: Int64) -> Rect {
        guard let prev = previousBox, let prevUs = previousUs, lastUs > prevUs else { return lastBox }
        let span = Double(lastUs - prevUs)
        let vx = (lastBox.center.x - prev.center.x) / span
        let vy = (lastBox.center.y - prev.center.y) / span
        let dt = Double(min(max(tUs - lastUs, 0), Tracker.coastUs))
        return lastBox.offsetBy(dx: vx * dt, dy: vy * dt)
    }

    /// Advances the track by one sampled frame. `candidates` are this frame's people in full-frame CFS.
    public mutating func step(tUs: Int64, candidates: [PersonCandidate]) -> TrackStep {
        if tUs - lastUs > Tracker.coastUs {
            return reacquire(tUs: tUs, candidates: candidates)
        }
        let pred = predictedBox(atUs: tUs)
        var scored: [(index: Int, cost: Double)] = []
        for (i, c) in candidates.enumerated() {
            guard c.bbox.isFinite, !c.bbox.isEmpty else { continue }
            let iou = pred.iou(c.bbox)
            let dc = centreDistance(pred, c.bbox)
            guard iou > Tracker.gateMinIoU || dc < Tracker.gateTorsoMultiple * torso else { continue }
            scored.append((i, cost(pred: pred, candidate: c.bbox, iou: iou, centreDistance: dc)))
        }
        // Stable order: lowest cost, then lowest index (deterministic tie-break).
        scored.sort { $0.cost != $1.cost ? $0.cost < $1.cost : $0.index < $1.index }

        guard let best = scored.first else {
            state = .coasting
            roi = .unit
            return TrackStep(index: nil, box: pred.clipped(to: .unit), coasted: true, reacquired: false, ambiguous: false, lost: false, roi: roi)
        }
        let ambiguous = scored.count > 1 && scored[1].cost <= best.cost * (1 + Tracker.ambiguityMargin)
        accept(candidates[best.index], tUs: tUs, keepVelocity: true)
        return TrackStep(index: best.index, box: lastBox, coasted: false, reacquired: false, ambiguous: ambiguous, lost: false, roi: roi)
    }

    // MARK: - Internals

    private mutating func reacquire(tUs: Int64, candidates: [PersonCandidate]) -> TrackStep {
        let anchor = lastBox.center
        var eligible: [(index: Int, dist: Double)] = []
        for (i, c) in candidates.enumerated() {
            guard c.bbox.isFinite, !c.bbox.isEmpty else { continue }
            let size = c.torso ?? 0
            let ratio: Double
            if size > 0 {
                ratio = size / torso
            } else {
                // No torso joints: compare box heights instead.
                ratio = lastBox.h > 0 ? c.bbox.h / lastBox.h : 0
            }
            guard abs(ratio - 1) <= Tracker.reacquireTolerance else { continue }
            let dx = (c.bbox.center.x - anchor.x) * aspect
            let dy = c.bbox.center.y - anchor.y
            eligible.append((i, (dx * dx + dy * dy).squareRoot()))
        }
        eligible.sort { $0.dist != $1.dist ? $0.dist < $1.dist : $0.index < $1.index }
        guard let best = eligible.first else {
            state = .lost
            roi = .unit
            return TrackStep(index: nil, box: nil, coasted: true, reacquired: false, ambiguous: false, lost: true, roi: roi)
        }
        let ambiguous = eligible.count > 1 && eligible[1].dist <= best.dist * (1 + Tracker.ambiguityMargin)
        accept(candidates[best.index], tUs: tUs, keepVelocity: false)
        resets += 1
        return TrackStep(index: best.index, box: lastBox, coasted: false, reacquired: true, ambiguous: ambiguous, lost: false, roi: roi)
    }

    private mutating func accept(_ c: PersonCandidate, tUs: Int64, keepVelocity: Bool) {
        if keepVelocity {
            previousBox = lastBox
            previousUs = lastUs
        } else {
            previousBox = nil
            previousUs = nil
        }
        lastBox = c.bbox
        lastUs = tUs
        if let t = c.torso, t > 0, t.isFinite {
            torso += (t - torso) * Tracker.torsoSmoothing
        }
        state = .tracking
        roi = Tracker.roi(around: c.bbox)
    }

    private func centreDistance(_ a: Rect, _ b: Rect) -> Double {
        let dx = (a.center.x - b.center.x) * aspect
        let dy = a.center.y - b.center.y
        return (dx * dx + dy * dy).squareRoot()
    }

    private func cost(pred: Rect, candidate: Rect, iou: Double, centreDistance dc: Double) -> Double {
        let diagW = pred.w * aspect
        let diag = (diagW * diagW + pred.h * pred.h).squareRoot()
        let distanceTerm = diag > 0 ? dc / diag : dc
        let areaTerm: Double
        if pred.area > 0, candidate.area > 0 {
            areaTerm = abs(log(candidate.area / pred.area))
        } else {
            areaTerm = 0
        }
        return (1 - iou) + 0.5 * distanceTerm + 0.2 * areaTerm
    }

    /// ROI around a target box: expanded 2×, height at least 40 % of the frame, shifted inside the frame.
    public static func roi(around box: Rect) -> Rect {
        guard box.isFinite, !box.isEmpty else { return .unit }
        var r = box.scaled(by: roiExpansion)
        if r.h < roiMinHeight {
            r = r.scaled(by: roiMinHeight / r.h)
        }
        r = r.shiftedInside(.unit)
        return r.isEmpty ? .unit : r
    }

    private static func positiveTorso(_ t: Double?, fallbackBox: Rect) -> Double {
        if let t, t > 0, t.isFinite { return t }
        // A standing player's box is roughly three torsos tall.
        let fallback = fallbackBox.h / 3
        return fallback > 0 && fallback.isFinite ? fallback : 0.1
    }
}
