import Foundation

/// PTS-based decimation of decoded frames to the analysis rate (DESIGN.md §5.3, §5.4 step 2).
///
/// A frame is kept when `pts ≥ nextT − 0.5/srcFps`; then `nextT = max(nextT, pts) + 1/targetHz`.
/// Taking the max means that after a VFR gap the schedule restarts from the late frame instead of emitting a burst
/// of catch-up frames. Frames whose PTS does not increase are always dropped (`tUs` must be strictly increasing).
/// All arithmetic is in µs so results are deterministic across platforms.
public struct FrameScheduler: Codable, Sendable, Hashable {
    public let targetHz: Int
    public let srcFps: Double
    /// Next wanted time in µs; nil before the first frame.
    public private(set) var nextUs: Double?
    /// PTS of the last kept frame.
    public private(set) var lastKeptUs: Int64?

    /// - Parameters:
    ///   - targetHz: 30 or 60 (any positive value works; non-positive falls back to 30).
    ///   - srcFps: nominal source frame rate; non-positive or non-finite falls back to `targetHz`.
    public init(targetHz: Int, srcFps: Double) {
        self.targetHz = targetHz > 0 ? targetHz : 30
        self.srcFps = (srcFps.isFinite && srcFps > 0) ? srcFps : Double(self.targetHz)
        nextUs = nil
        lastKeptUs = nil
    }

    public var periodUs: Double { 1_000_000 / Double(targetHz) }
    public var halfSourceFrameUs: Double { 500_000 / srcFps }

    /// Decides whether to keep the frame at `ptsUs` and advances the schedule when it is kept.
    public mutating func shouldKeep(ptsUs: Int64) -> Bool {
        if let last = lastKeptUs, ptsUs <= last { return false }
        let pts = Double(ptsUs)
        if let next = nextUs, pts < next - halfSourceFrameUs { return false }
        nextUs = max(nextUs ?? pts, pts) + periodUs
        lastKeptUs = ptsUs
        return true
    }

    /// Restarts the schedule (e.g. a new reader after a background resume) so that the next kept frame is the first
    /// one at or after `ptsUs`'s slot; frames at or before `lastKeptUs` stay dropped.
    public mutating func resume(afterUs ptsUs: Int64) {
        lastKeptUs = ptsUs
        nextUs = Double(ptsUs) + periodUs
    }
}

/// Exact conversions for asset-timeline PTS.
public enum Timebase {
    /// µs from a CMTime-style rational `value / timescale`, rounded half away from zero; nil for an invalid timescale.
    public static func microseconds(value: Int64, timescale: Int32) -> Int64? {
        guard timescale > 0 else { return nil }
        let ts = Int64(timescale)
        // value · 1e6 can overflow for absurd values; fall back to Double in that case.
        let (product, overflow) = value.multipliedReportingOverflow(by: 1_000_000)
        if !overflow {
            let q = product / ts
            let r = product % ts
            // Round half away from zero.
            if 2 * abs(r) >= ts { return product >= 0 ? q + 1 : q - 1 }
            return q
        }
        let seconds = Double(value) / Double(timescale)
        let us = (seconds * 1_000_000).rounded()
        guard us.isFinite, abs(us) < 9.0e18 else { return nil }
        return Int64(us)
    }

    /// Whole milliseconds from µs (floor), as used by `segment` and `ambiguousAtMs`.
    public static func milliseconds(fromMicroseconds us: Int64) -> Int64 {
        us >= 0 ? us / 1000 : -((-us + 999) / 1000)
    }
}
