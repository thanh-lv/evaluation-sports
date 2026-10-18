import Foundation

/// Player selection at the first frame in `[segment start, +3 s]` that contains people (DESIGN.md §5.4 step 4).
public enum TargetSelector {
    /// Selection window after the segment start.
    public static let selectionWindowUs: Int64 = 3_000_000
    public static let autoMinMeanConfidence = 0.5
    public static let autoMaxOtherAreaRatio = 0.3

    /// Auto-select silently when exactly one candidate is dominant: mean confidence ≥ 0.5 and every other candidate's
    /// box area < 30 % of its area. Otherwise nil: the app shows the tap screen.
    ///
    /// Reading of DESIGN.md §5.4 step 4: a small, confidently detected bystander (area < 30 %) does not block
    /// auto-selection; a second person of comparable size does, whatever their confidence.
    public static func autoSelect(candidates: [PersonCandidate]) -> Int? {
        let dominant = candidates.indices.filter { i in
            let c = candidates[i]
            guard c.meanConfidence >= autoMinMeanConfidence, c.bbox.area > 0 else { return false }
            return candidates.indices.allSatisfy { j in
                j == i || candidates[j].bbox.area < autoMaxOtherAreaRatio * c.bbox.area
            }
        }
        return dominant.count == 1 ? dominant.first : nil
    }

    /// Tap selection (CFS-normalized tap): the box containing the tap; when several contain it, the one whose centre is
    /// nearest (aspect-corrected). nil when no box contains the tap.
    public static func select(tap: Point, candidates: [PersonCandidate], aspect: Double = 1) -> Int? {
        let ax = (aspect.isFinite && aspect > 0) ? aspect : 1
        var best: (index: Int, dist: Double)?
        for (i, c) in candidates.enumerated() where c.bbox.contains(tap) {
            let dx = (c.bbox.center.x - tap.x) * ax
            let dy = c.bbox.center.y - tap.y
            let d = (dx * dx + dy * dy).squareRoot()
            if best == nil || d < (best?.dist ?? .infinity) { best = (i, d) }
        }
        return best?.index
    }

    /// True when `tUs` is still inside the selection window that starts at `segmentStartUs`.
    public static func isInSelectionWindow(tUs: Int64, segmentStartUs: Int64) -> Bool {
        tUs - segmentStartUs <= selectionWindowUs
    }
}
