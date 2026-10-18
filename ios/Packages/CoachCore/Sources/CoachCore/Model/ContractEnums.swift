import Foundation

// Wire enums mirroring `supabase/functions/_shared/contracts/common.ts`. Raw values are the JSON strings.

public enum Sport: String, Codable, Sendable, CaseIterable {
    case badminton, pickleball

    /// Sport of a skill id (`bd.*` / `pb.*`), nil for anything else.
    public static func of(skill: String) -> Sport? {
        if skill.hasPrefix("bd.") { return .badminton }
        if skill.hasPrefix("pb.") { return .pickleball }
        return nil
    }
}

public enum Handedness: String, Codable, Sendable, CaseIterable {
    case right, left
}

/// Player level (profile) and result level label.
public enum Level: String, Codable, Sendable, CaseIterable {
    case beginner, improving, intermediate, advanced
}

/// Camera view picked by the user; `auto` means "use the server's viewGuess".
public enum CameraView: String, Codable, Sendable, CaseIterable {
    case side, behind, front, diagonal, auto
}

/// A concrete view (never `auto`).
public enum ConfirmedCameraView: String, Codable, Sendable, CaseIterable {
    case side, behind, front, diagonal

    public var cameraView: CameraView {
        switch self {
        case .side: return .side
        case .behind: return .behind
        case .front: return .front
        case .diagonal: return .diagonal
        }
    }
}

/// Rubric view codes used by the catalog (`S`, `B`, `D`, `F`).
public enum ViewCode: String, Codable, Sendable, CaseIterable {
    case S, B, D, F
}

public enum Language: String, Codable, Sendable, CaseIterable {
    case vi, en
}

/// Who is filmed. Wire value `"self"` is the case `oneself` (a case named `self` would clash with `Subject.self`).
public enum Subject: String, Codable, Sendable, CaseIterable {
    case oneself = "self"
    case other
}

public enum FrameMode: String, Codable, Sendable, CaseIterable {
    case frames
    case poseOnly = "pose_only"
}

public enum Tier: String, Codable, Sendable, CaseIterable {
    case free, trial, premium
}

/// Model route kind: basic = Haiku, standard = Sonnet.
public enum AnalysisKind: String, Codable, Sendable, CaseIterable {
    case basic, standard
}

public enum AnalysisStatus: String, Codable, Sendable, CaseIterable {
    case prepared, queued, processing, succeeded, rejected, failed
}

public enum SubScoreKey: String, Codable, Sendable, CaseIterable {
    case stance, footwork, swing, contact, follow, recovery
}

/// Phases that get a key frame.
public enum StrokePhase: String, Codable, Sendable, CaseIterable {
    case ready, bsEnd, contact, ftStop
}

/// Phase label of a frame request; `overview` is F5.
public enum FramePhase: String, Codable, Sendable, CaseIterable {
    case ready, bsEnd, contact, ftStop, overview
}

/// Key-frame ids: F1–F5 are uploaded (best stroke + overview), L1–L4 stay on device (worst stroke).
public enum FrameId: String, Codable, Sendable, CaseIterable {
    case F1, F2, F3, F4, F5, L1, L2, L3, L4

    public var isUploadId: Bool {
        switch self {
        case .F1, .F2, .F3, .F4, .F5: return true
        case .L1, .L2, .L3, .L4: return false
        }
    }
}

public enum StrokeRole: String, Codable, Sendable, CaseIterable {
    case best, worst
}

public enum Severity: String, Codable, Sendable, CaseIterable {
    case high, medium, low
}

public enum Confidence: String, Codable, Sendable, CaseIterable {
    case low, medium, high
}

public enum SafetyKind: String, Codable, Sendable, CaseIterable {
    case warmup, load
    case techniqueRisk = "technique_risk"
    case seeProfessional = "see_professional"
}

/// Checkpoint assessment tag in `coach-result.v1` checkpoints.
public enum AssessTag: String, Codable, Sendable, CaseIterable {
    case M
    case mApprox = "M~"
    case V
    case N
}

/// String Catalog keys for recording tips (contracts `TIP_KEYS`). The app must localize every one.
public enum TipKey: String, Codable, Sendable, CaseIterable {
    case fullBody = "camera.tip.full_body"
    case moveCloser = "camera.tip.move_closer"
    case playerHeight = "camera.tip.player_height"
    case lighting = "camera.tip.lighting"
    case steadyCamera = "camera.tip.steady_camera"
    case onePlayer = "camera.tip.one_player"
    case fps60 = "camera.tip.fps_60"
    case repetitions = "camera.tip.repetitions"
    case clipLength = "camera.tip.clip_length"
    case recommendedView = "camera.tip.recommended_view"
    case chooseSkill = "camera.tip.choose_skill"
}
