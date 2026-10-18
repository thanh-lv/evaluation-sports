import Foundation

/// Device thermal level (mirror of `ProcessInfo.ThermalState`, which is Apple-only).
public enum ThermalLevel: Int, Codable, Sendable, Comparable, CaseIterable {
    case nominal = 0, fair, serious, critical

    public static func < (lhs: ThermalLevel, rhs: ThermalLevel) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// Verdict on the source frame rate (DESIGN.md §5.4 step 1).
public enum SourceFpsVerdict: String, Codable, Sendable {
    case ok
    /// Below 30 fps: analyse, but the server adds `fps_low`.
    case warn
    /// Below 24 fps: reject before any upload (`fps_too_low`).
    case reject
}

/// Chooses the analysis rate, 30 or 60 Hz (DESIGN.md §5.3 `RateChooser`, §5.4 step 1).
///
/// Below 50 fps the rate is 30 Hz. Otherwise Vision calls 6–25 are timed (the first 5 are warm-up and discarded),
/// `projected = msPerFrame × segSec × 60`, and 60 Hz is used if
/// `projected ≤ 1.5 × segSec × 1000 + 10 000` and the thermal state is at most `.fair`.
public struct RateChooser: Codable, Sendable, Hashable {
    public static let warmupCalls = 5
    public static let timedCalls = 20
    public static let highRateMinSourceFps = 50.0
    public static let warnBelowFps = 30.0
    public static let rejectBelowFps = 24.0

    public let srcFps: Double
    public let segmentSec: Double
    public private(set) var callsSeen = 0
    public private(set) var timedMs: [Double] = []

    public init(srcFps: Double, segmentSec: Double) {
        self.srcFps = srcFps
        self.segmentSec = segmentSec
    }

    /// Whether a benchmark is needed at all (sources below 50 fps always run at 30 Hz).
    public var needsBenchmark: Bool { srcFps >= RateChooser.highRateMinSourceFps }

    /// Records the wall time of one Vision call. Calls beyond the timed window are ignored.
    public mutating func recordVisionCall(milliseconds ms: Double) {
        callsSeen += 1
        guard callsSeen > RateChooser.warmupCalls, timedMs.count < RateChooser.timedCalls, ms.isFinite, ms >= 0 else {
            return
        }
        timedMs.append(ms)
    }

    /// True once all timed calls have been recorded (or no benchmark is needed).
    public var isComplete: Bool { !needsBenchmark || timedMs.count >= RateChooser.timedCalls }

    /// Mean ms per Vision call over the timed window; nil before any timed call.
    public var msPerFrame: Double? {
        guard !timedMs.isEmpty else { return nil }
        return timedMs.reduce(0, +) / Double(timedMs.count)
    }

    /// The decision with the samples gathered so far; 30 Hz while incomplete.
    public func decide(thermal: ThermalLevel) -> Int {
        guard needsBenchmark else { return 30 }
        guard isComplete, let ms = msPerFrame else { return 30 }
        return RateChooser.choose(srcFps: srcFps, msPerFrame: ms, segmentSec: segmentSec, thermal: thermal)
    }

    /// Pure rule.
    public static func choose(srcFps: Double, msPerFrame: Double, segmentSec: Double, thermal: ThermalLevel) -> Int {
        guard srcFps >= highRateMinSourceFps, msPerFrame.isFinite, segmentSec.isFinite, segmentSec > 0 else { return 30 }
        let projectedMs = msPerFrame * segmentSec * 60
        let budgetMs = 1.5 * segmentSec * 1000 + 10_000
        return projectedMs <= budgetMs && thermal <= .fair ? 60 : 30
    }

    /// Below 30 fps warn, below 24 fps reject.
    public static func sourceFpsVerdict(_ srcFps: Double) -> SourceFpsVerdict {
        guard srcFps.isFinite else { return .reject }
        if srcFps < rejectBelowFps { return .reject }
        if srcFps < warnBelowFps { return .warn }
        return .ok
    }
}
