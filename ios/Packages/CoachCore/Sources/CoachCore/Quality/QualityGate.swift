import Foundation

/// A quality problem found on device. Rejection raw values are the server's `ApiError` codes, so the app shows the
/// same copy and tips for a local and a server rejection; `playerSmall` / `fpsLow` are warnings only.
public enum QualityIssue: String, Codable, Sendable, CaseIterable {
    /// Target present in < 60 % of frames.
    case targetLost = "target_lost"
    /// Median player height < 25 % of the frame.
    case playerTooSmall = "player_too_small"
    /// Mean limb confidence < 0.4.
    case lowVisibility = "low_visibility"
    /// Fewer than 2 sampled frames.
    case tooFewFrames = "too_few_frames"
    /// Source below 24 fps.
    case fpsTooLow = "fps_too_low"
    /// Segment shorter than 3 s / longer than 32 s.
    case clipTooShort = "clip_too_short"
    case clipTooLong = "clip_too_long"
    /// Warning: median player height 25–35 %.
    case playerSmall = "player_small"
    /// Warning: source below 30 fps.
    case fpsLow = "fps_low"

    /// Recording tips (String Catalog keys), matching contracts `REJECTION_TIPS`.
    public var tips: [TipKey] {
        switch self {
        case .targetLost: return [.onePlayer, .fullBody]
        case .playerTooSmall, .playerSmall: return [.moveCloser, .playerHeight]
        case .lowVisibility: return [.lighting, .fullBody, .steadyCamera]
        case .tooFewFrames: return [.clipLength, .fullBody]
        case .fpsTooLow, .fpsLow: return [.fps60]
        case .clipTooShort, .clipTooLong: return [.clipLength]
        }
    }
}

public struct QualityVerdict: Codable, Sendable, Hashable {
    /// Blocking problems, most important first. Non-empty → do not call prepare (no quota is used either way).
    public var rejections: [QualityIssue]
    public var warnings: [QualityIssue]

    public init(rejections: [QualityIssue], warnings: [QualityIssue]) {
        self.rejections = rejections
        self.warnings = warnings
    }

    public var passed: Bool { rejections.isEmpty }
    /// Tips for the first rejection (or the first warning), deduplicated in order.
    public var tips: [TipKey] {
        var seen = Set<TipKey>()
        var out: [TipKey] = []
        for issue in rejections + warnings {
            for t in issue.tips where !seen.contains(t) {
                seen.insert(t)
                out.append(t)
            }
        }
        return out
    }
}

/// On-device quality gate (DESIGN.md §5.4 step 6), evaluated before `prepare`.
public enum QualityGate {
    public static let minPresence = 0.6
    public static let rejectHeightBelow = 0.25
    public static let warnHeightBelow = 0.35
    public static let minMeanLimbConf = 0.4
    public static let minFrames = 2
    public static let minSegmentMs: Int64 = 3_000
    public static let maxSegmentMs: Int64 = 32_000

    /// - Parameters:
    ///   - srcFps: when given, adds the fps rules (reject < 24, warn < 30).
    ///   - segmentMs: when given, adds the segment-length rules (3–32 s, as checked by the server).
    public static func evaluate(_ s: QualityStats, srcFps: Double? = nil, segmentMs: Int64? = nil) -> QualityVerdict {
        var rejections: [QualityIssue] = []
        var warnings: [QualityIssue] = []

        if let fps = srcFps {
            switch RateChooser.sourceFpsVerdict(fps) {
            case .reject: rejections.append(.fpsTooLow)
            case .warn: warnings.append(.fpsLow)
            case .ok: break
            }
        }
        if let ms = segmentMs {
            if ms < minSegmentMs { rejections.append(.clipTooShort) }
            if ms > maxSegmentMs { rejections.append(.clipTooLong) }
        }
        if s.framesTotal < minFrames {
            rejections.append(.tooFewFrames)
            return QualityVerdict(rejections: rejections, warnings: warnings)
        }
        if s.presence < minPresence { rejections.append(.targetLost) }
        if s.framesWithTarget > 0 {
            if s.playerHeightFracMedian < rejectHeightBelow {
                rejections.append(.playerTooSmall)
            } else if s.playerHeightFracMedian < warnHeightBelow {
                warnings.append(.playerSmall)
            }
            if s.meanLimbConf < minMeanLimbConf { rejections.append(.lowVisibility) }
        }
        return QualityVerdict(rejections: rejections, warnings: warnings)
    }
}
