import Foundation

/// One detected joint: CFS-normalized position (0…1, top-left origin, upright display frame) and confidence 0…1.
public struct Keypoint: Codable, Sendable, Hashable {
    public var x: Double
    public var y: Double
    public var c: Double

    public init(x: Double, y: Double, c: Double) {
        self.x = x
        self.y = y
        self.c = c
    }

    public var point: Point { Point(x: x, y: y) }
}

/// One person detected in a frame (one Vision body-pose observation), already mapped to full-frame CFS.
public struct PersonCandidate: Codable, Sendable, Hashable {
    /// Detected joints (any confidence). Missing joints are absent.
    public var joints: [Joint: Keypoint]
    /// Target box in CFS-normalized coordinates (see `CandidateBuilder`).
    public var bbox: Rect
    /// Torso length |neck − root| in frame-height units (aspect-corrected); nil when not measurable.
    public var torso: Double?
    /// Mean confidence over all 19 joints, a missing joint counting as 0.
    public var meanConfidence: Double

    public init(joints: [Joint: Keypoint], bbox: Rect, torso: Double?, meanConfidence: Double) {
        self.joints = joints
        self.bbox = bbox
        self.torso = torso
        self.meanConfidence = meanConfidence
    }

    public subscript(joint: Joint) -> Keypoint? { joints[joint] }

    /// Joints at or above `minConfidence`, as points.
    public func points(minConfidence: Double = CandidateBuilder.minJointConfidence) -> [Joint: Point] {
        var out: [Joint: Point] = [:]
        for j in Joint.allCases {
            if let k = joints[j], k.c >= minConfidence { out[j] = k.point }
        }
        return out
    }
}
