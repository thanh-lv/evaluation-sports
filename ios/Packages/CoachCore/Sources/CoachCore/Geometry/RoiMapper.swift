import Foundation

/// Coordinate conversions between Vision space and CFS (DESIGN.md §5.3).
///
/// - Vision: normalized 0…1, origin **bottom-left**. With `regionOfInterest` set, results are normalized to the ROI
///   (`VNImagePointForNormalizedPointUsingRegionOfInterest` semantics; verify on device, see `roiRelative`).
/// - CFS (CoachCore): normalized 0…1 of the upright full frame, origin **top-left**.
///
/// ROIs are stored by the tracker in CFS; `visionRegion(fromCFS:)` converts one for `regionOfInterest`.
public enum RoiMapper {
    /// CFS rect → Vision rect (bottom-left origin).
    public static func visionRegion(fromCFS r: Rect) -> Rect {
        Rect(x: r.x, y: 1 - r.y - r.h, w: r.w, h: r.h)
    }

    /// Vision rect (bottom-left origin) → CFS rect. (The flip is its own inverse.)
    public static func cfsRegion(fromVision r: Rect) -> Rect {
        Rect(x: r.x, y: 1 - r.y - r.h, w: r.w, h: r.h)
    }

    /// Full-frame Vision point → CFS point.
    public static func cfs(fromVision p: Point) -> Point {
        Point(x: p.x, y: 1 - p.y)
    }

    /// CFS point → full-frame Vision point.
    public static func vision(fromCFS p: Point) -> Point {
        Point(x: p.x, y: 1 - p.y)
    }

    /// ROI-normalized point → full-frame normalized point. Both use the same origin convention as `roi`.
    public static func full(fromRoi p: Point, roi: Rect) -> Point {
        Point(x: roi.x + p.x * roi.w, y: roi.y + p.y * roi.h)
    }

    /// Full-frame normalized point → ROI-normalized point (same origin convention as `roi`).
    /// A degenerate ROI maps everything to the origin rather than producing NaN.
    public static func roi(fromFull p: Point, roi: Rect) -> Point {
        guard roi.w > 0, roi.h > 0 else { return .zero }
        return Point(x: (p.x - roi.x) / roi.w, y: (p.y - roi.y) / roi.h)
    }

    /// A Vision result point (bottom-left, relative to the ROI when `roiRelative`) → full-frame CFS point.
    /// `cfsRoi` is the ROI that was requested, in CFS.
    public static func cfsPoint(fromVisionPoint p: Point, cfsRoi: Rect, roiRelative: Bool = true) -> Point {
        let fullVision = roiRelative ? full(fromRoi: p, roi: visionRegion(fromCFS: cfsRoi)) : p
        return cfs(fromVision: fullVision)
    }

    /// Inverse of `cfsPoint(fromVisionPoint:cfsRoi:roiRelative:)`.
    public static func visionPoint(fromCFSPoint p: Point, cfsRoi: Rect, roiRelative: Bool = true) -> Point {
        let fullVision = vision(fromCFS: p)
        return roiRelative ? roi(fromFull: fullVision, roi: visionRegion(fromCFS: cfsRoi)) : fullVision
    }
}
