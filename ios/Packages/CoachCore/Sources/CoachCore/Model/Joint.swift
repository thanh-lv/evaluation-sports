import Foundation

/// The 19 Vision body joints, in payload `jointOrder` (contracts `JOINT_ORDER`).
///
/// Names are our own and are what goes on the wire; Vision's raw joint identifiers are never persisted
/// (the app maps `VNHumanBodyPoseObservation.JointName` → `Joint` with an explicit switch).
public enum Joint: String, CaseIterable, Codable, Sendable, Hashable, CodingKeyRepresentable {
    case nose, lEye, rEye, lEar, rEar, neck
    case lSho, rSho, lElb, rElb, lWri, rWri
    case root, lHip, rHip, lKne, rKne, lAnk, rAnk

    public static let count = 19

    /// Payload order; equals `allCases`.
    public static let order: [Joint] = Joint.allCases

    /// Index in `jointOrder` (kp offset = 3 × index, interp bit = index).
    public var index: Int {
        // allCases is declared in payload order, so firstIndex is exact; the fallback is unreachable.
        Joint.allCases.firstIndex(of: self) ?? 0
    }

    /// `Joint` for a payload index, nil when out of range.
    public init?(index: Int) {
        guard index >= 0, index < Joint.allCases.count else { return nil }
        self = Joint.allCases[index]
    }

    /// Limb joints used for `meanLimbConf` (shoulders, elbows, wrists, hips, knees, ankles).
    public static let limbs: [Joint] = [.lSho, .rSho, .lElb, .rElb, .lWri, .rWri, .lHip, .rHip, .lKne, .rKne, .lAnk, .rAnk]

    /// The anatomical mirror (left ↔ right); centre joints map to themselves.
    public var mirrored: Joint {
        switch self {
        case .lEye: return .rEye
        case .rEye: return .lEye
        case .lEar: return .rEar
        case .rEar: return .lEar
        case .lSho: return .rSho
        case .rSho: return .lSho
        case .lElb: return .rElb
        case .rElb: return .lElb
        case .lWri: return .rWri
        case .rWri: return .lWri
        case .lHip: return .rHip
        case .rHip: return .lHip
        case .lKne: return .rKne
        case .rKne: return .lKne
        case .lAnk: return .rAnk
        case .rAnk: return .lAnk
        case .nose, .neck, .root: return self
        }
    }
}
