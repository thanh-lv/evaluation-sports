import Foundation

/// `reprepare.v1`: re-runs prepare on the stored pose after the "Xác nhận cú đánh" screen (DESIGN.md §7.2).
/// The client always sends the full current choice, not a diff.
public struct ReprepareV1: Codable, Sendable, Hashable {
    public static let schemaId = "reprepare.v1"
    public static let maxExcluded = 12

    public var schema: String
    public var analysisId: String
    /// Confirmed view (never `auto`).
    public var cameraView: ConfirmedCameraView
    /// Stroke ids the user unticked.
    public var excludedStrokeIds: [Int]
    public var handedness: Handedness

    /// `analysisId` is lowercased here so callers cannot send an uppercase id.
    public init(analysisId: String, cameraView: ConfirmedCameraView, excludedStrokeIds: [Int], handedness: Handedness) {
        self.schema = ReprepareV1.schemaId
        self.analysisId = IDs.lower(analysisId) ?? analysisId.lowercased()
        self.cameraView = cameraView
        self.excludedStrokeIds = excludedStrokeIds.sorted()
        self.handedness = handedness
    }

    public init(analysisId: UUID, cameraView: ConfirmedCameraView, excludedStrokeIds: [Int], handedness: Handedness) {
        self.init(analysisId: IDs.lower(analysisId), cameraView: cameraView, excludedStrokeIds: excludedStrokeIds, handedness: handedness)
    }
}
