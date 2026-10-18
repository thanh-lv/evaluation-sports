import Foundation

/// Time-indexed poses for skeleton playback (DESIGN-v1.0 §5.3 `Overlay/`).
///
/// `pose(atUs:)` binary-searches the frame times and linearly interpolates each joint between the two neighbouring
/// frames when both have it. Across a gap longer than 100 ms the skeleton is hidden (nil). Points are CFS-normalized
/// (0…1, top-left of the upright display frame); map them with the player's video rect.
public struct PoseTimeline: Sendable, Hashable {
    public static let maxGapUs: Int64 = 100_000

    public let tUs: [Int64]
    /// Per frame, per joint (`Joint.index`): the point, or nil when missing.
    let frames: [[Point?]]

    /// - Parameters:
    ///   - tUs: strictly increasing frame times; frames that break the order are skipped.
    ///   - poses: one joint map per time (same count as `tUs`; extra entries on either side are ignored).
    public init(tUs: [Int64], poses: [[Joint: Point]]) {
        var times: [Int64] = []
        var rows: [[Point?]] = []
        let n = min(tUs.count, poses.count)
        times.reserveCapacity(n)
        rows.reserveCapacity(n)
        for i in 0..<n {
            if let last = times.last, tUs[i] <= last { continue }
            times.append(tUs[i])
            rows.append(Joint.allCases.map { poses[i][$0] })
        }
        self.tUs = times
        self.frames = rows
    }

    /// From a clean track (`pose.clean.json`): missing joints (c = 0) are hidden; gap-filled joints are shown.
    public init(cleanTrack: CleanTrackV1) {
        let n = min(cleanTrack.tUs.count, cleanTrack.kp.count)
        var poses: [[Joint: Point]] = []
        poses.reserveCapacity(n)
        for i in 0..<n {
            poses.append(cleanTrack.joints(at: i).mapValues(\.point))
        }
        self.init(tUs: Array(cleanTrack.tUs.prefix(n)), poses: poses)
    }

    /// From a raw `pose.v1` track (e.g. the debug export): joints below the wire threshold are already missing.
    /// L/R labels are as sent (not mirror-corrected); positions are display space either way.
    public init(pose: PoseV1) {
        let n = min(pose.track.tUs.count, pose.track.kp.count)
        var poses: [[Joint: Point]] = []
        poses.reserveCapacity(n)
        for i in 0..<n {
            poses.append(pose.track.joints(at: i).mapValues(\.point))
        }
        self.init(tUs: Array(pose.track.tUs.prefix(n)), poses: poses)
    }

    public var isEmpty: Bool { tUs.isEmpty }
    public var startUs: Int64? { tUs.first }
    public var endUs: Int64? { tUs.last }

    /// Pose at `t` (µs, asset timeline); nil outside the track or inside a gap > 100 ms.
    public func pose(atUs t: Int64) -> [Joint: Point]? {
        guard let first = tUs.first, let last = tUs.last, t >= first, t <= last else { return nil }
        // Largest index with tUs[i] <= t.
        var lo = 0
        var hi = tUs.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if tUs[mid] <= t { lo = mid } else { hi = mid - 1 }
        }
        let i = lo
        if tUs[i] == t || i == tUs.count - 1 { return joints(frames[i]) }
        let t0 = tUs[i]
        let t1 = tUs[i + 1]
        guard t1 - t0 <= PoseTimeline.maxGapUs else { return nil }
        let u = Double(t - t0) / Double(t1 - t0)
        var out: [Joint: Point] = [:]
        for j in Joint.allCases {
            let k = j.index
            if let a = frames[i][k], let b = frames[i + 1][k] {
                out[j] = a.lerp(to: b, u)
            }
        }
        return out
    }

    /// Pose at the sampled frame nearest to `t` (no interpolation), within `toleranceUs`.
    public func nearestPose(atUs t: Int64, toleranceUs: Int64 = 50_000) -> [Joint: Point]? {
        guard let i = nearestIndex(atUs: t), abs(tUs[i] - t) <= toleranceUs else { return nil }
        return joints(frames[i])
    }

    /// Index of the frame nearest to `t`; nil for an empty timeline.
    public func nearestIndex(atUs t: Int64) -> Int? {
        guard !tUs.isEmpty else { return nil }
        var lo = 0
        var hi = tUs.count - 1
        while lo < hi {
            let mid = (lo + hi) / 2
            if tUs[mid] < t { lo = mid + 1 } else { hi = mid }
        }
        if lo > 0, abs(tUs[lo - 1] - t) <= abs(tUs[lo] - t) { return lo - 1 }
        return lo
    }

    private func joints(_ row: [Point?]) -> [Joint: Point] {
        var out: [Joint: Point] = [:]
        for j in Joint.allCases {
            if let p = row[j.index] { out[j] = p }
        }
        return out
    }
}
