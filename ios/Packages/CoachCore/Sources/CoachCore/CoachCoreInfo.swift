import Foundation

/// Package-level constants. (Not named `CoachCore` so that `CoachCore.X` always resolves to the module.)
public enum CoachCoreInfo {
    /// Sent as `pose.v1` `client.algo`; bump when sampling, tracking or quantization behaviour changes.
    public static let algoVersion = "coachcore-1.0.0"
    /// `client.poseApi` for the Vision adapter.
    public static let visionPoseApi = "VNDetectHumanBodyPoseRequest"
}
