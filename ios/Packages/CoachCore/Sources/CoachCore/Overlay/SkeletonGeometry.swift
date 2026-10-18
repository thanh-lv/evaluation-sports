import Foundation

/// A skeleton bone between two joints.
public struct Bone: Codable, Sendable, Hashable {
    public var from: Joint
    public var to: Joint

    public init(_ from: Joint, _ to: Joint) {
        self.from = from
        self.to = to
    }

    public var joints: [Joint] { [from, to] }
}

/// Skeleton drawing topology (DESIGN-v1.0 §5.3 `Overlay/`).
public enum SkeletonGeometry {
    /// The 14 bones: head–neck, shoulders, arms, spine, hips, legs.
    public static let bones: [Bone] = [
        Bone(.nose, .neck),
        Bone(.neck, .lSho),
        Bone(.neck, .rSho),
        Bone(.lSho, .lElb),
        Bone(.lElb, .lWri),
        Bone(.rSho, .rElb),
        Bone(.rElb, .rWri),
        Bone(.neck, .root),
        Bone(.root, .lHip),
        Bone(.root, .rHip),
        Bone(.lHip, .lKne),
        Bone(.lKne, .lAnk),
        Bone(.rHip, .rKne),
        Bone(.rKne, .rAnk),
    ]

    /// Joints drawn as dots (eyes and ears are left out to keep the overlay clean).
    public static let dotJoints: [Joint] = [
        .nose, .neck, .lSho, .rSho, .lElb, .rElb, .lWri, .rWri, .root, .lHip, .rHip, .lKne, .rKne, .lAnk, .rAnk,
    ]

    /// Bones whose both ends are present in `pose`.
    public static func visibleBones(in pose: [Joint: Point]) -> [Bone] {
        bones.filter { pose[$0.from] != nil && pose[$0.to] != nil }
    }
}
