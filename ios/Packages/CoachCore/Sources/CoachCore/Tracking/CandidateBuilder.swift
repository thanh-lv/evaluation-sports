import Foundation

/// Builds `PersonCandidate`s from raw joints (DESIGN-v1.0 §5.3, research ios-pose §3.4).
///
/// Box = min/max of joints with c ≥ 0.3, padded by 10 % of its size (5 % per side) plus 0.5 torso of headroom above,
/// clipped to the frame. The torso unit is |neck − root| in frame-height units (x scaled by the aspect ratio), with
/// shoulder-mid / hip-mid as fallbacks.
public enum CandidateBuilder {
    public static let minJointConfidence = 0.3
    /// Fewer usable joints than this → not a candidate (too little to box or track reliably).
    public static let minJoints = 4
    public static let padFraction = 0.10
    public static let headroomTorso = 0.5

    /// - Parameters:
    ///   - joints: CFS-normalized joints of one observation (any confidence; non-finite values are ignored).
    ///   - aspect: display width / height.
    public static func build(joints rawJoints: [Joint: Keypoint], aspect: Double) -> PersonCandidate? {
        let aspect = (aspect.isFinite && aspect > 0) ? aspect : 1
        var joints: [Joint: Keypoint] = [:]
        for j in Joint.allCases {
            guard let k = rawJoints[j], k.x.isFinite, k.y.isFinite, k.c.isFinite else { continue }
            joints[j] = Keypoint(x: k.x, y: k.y, c: min(max(k.c, 0), 1))
        }
        let good = Joint.allCases.compactMap { j -> Point? in
            guard let k = joints[j], k.c >= minJointConfidence else { return nil }
            return k.point
        }
        guard good.count >= minJoints, let raw = Rect(bounding: good) else { return nil }

        let torso = torsoLength(joints, aspect: aspect)
        let padX = raw.w * padFraction / 2
        let padY = raw.h * padFraction / 2
        let headroom = (torso ?? raw.h / 3) * headroomTorso
        let padded = Rect(x: raw.x - padX, y: raw.y - padY - headroom, w: raw.w + 2 * padX, h: raw.h + 2 * padY + headroom)
        let bbox = padded.clipped(to: .unit)
        guard !bbox.isEmpty else { return nil }

        let confSum = Joint.allCases.reduce(0.0) { $0 + (joints[$1]?.c ?? 0) }
        return PersonCandidate(joints: joints, bbox: bbox, torso: torso, meanConfidence: confSum / Double(Joint.count))
    }

    /// Torso length in frame-height units from joints with c ≥ 0.3; nil when neither pair is available.
    public static func torsoLength(_ joints: [Joint: Keypoint], aspect: Double) -> Double? {
        func p(_ j: Joint) -> Point? {
            guard let k = joints[j], k.c >= minJointConfidence else { return nil }
            return Point(x: k.x * aspect, y: k.y)
        }
        func mid(_ a: Joint, _ b: Joint) -> Point? {
            guard let pa = p(a), let pb = p(b) else { return nil }
            return pa.lerp(to: pb, 0.5)
        }
        let top = p(.neck) ?? mid(.lSho, .rSho)
        let bottom = p(.root) ?? mid(.lHip, .rHip)
        guard let t = top, let b = bottom else { return nil }
        let d = t.distance(to: b)
        return d > 0 ? d : nil
    }
}
