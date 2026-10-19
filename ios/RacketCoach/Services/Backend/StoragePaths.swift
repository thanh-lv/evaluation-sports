import CoachCore
import Foundation

/// Storage object names (DESIGN.md §6.6). Every id is lowercased with `IDs.lower`, because Storage RLS compares the
/// first folder with `auth.uid()::text` (lowercase) and the INSERT/UPDATE policy also checks the exact lowercase path.
enum StoragePaths {
    static let inputsBucket = "analysis-inputs"
    static let derivedBucket = "analysis-derived"

    /// `{uid}/{aid}/frames/F1.jpg`. Returns nil for a local-only frame (L1–L4) or a malformed id.
    static func frame(userId: String, analysisId: String, frameId: FrameId) -> String? {
        guard frameId.isUploadId, let uid = IDs.lower(userId), let aid = IDs.lower(analysisId) else { return nil }
        return "\(uid)/\(aid)/frames/\(frameId.rawValue).jpg"
    }

    /// `{uid}/{aid}/pose.clean.json` (also returned by prepare as `cleanTrackPath`).
    static func cleanTrack(userId: String, analysisId: String) -> String? {
        guard let uid = IDs.lower(userId), let aid = IDs.lower(analysisId) else { return nil }
        return "\(uid)/\(aid)/pose.clean.json"
    }

    /// `{uid}/{aid}/pose.raw.json`.
    static func rawPose(userId: String, analysisId: String) -> String? {
        guard let uid = IDs.lower(userId), let aid = IDs.lower(analysisId) else { return nil }
        return "\(uid)/\(aid)/pose.raw.json"
    }

    /// Every input object an analysis can have (for deletion).
    static func allFrames(userId: String, analysisId: String) -> [String] {
        FrameId.allCases.compactMap { frame(userId: userId, analysisId: analysisId, frameId: $0) }
    }
}
