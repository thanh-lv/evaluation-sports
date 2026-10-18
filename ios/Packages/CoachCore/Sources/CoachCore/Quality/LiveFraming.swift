import Foundation

/// Hint shown under the recorder's traffic light. Raw values are String Catalog keys the app must define.
public enum FramingHint: String, Codable, Sendable, CaseIterable {
    /// "Lùi xa hơn": player too tall in the frame.
    case stepBack = "framing.hint.step_back"
    /// "Thấy cả bàn chân": ankles (or wrists) not visible.
    case showFeet = "framing.hint.show_feet"
    /// "Ngược sáng": exposure out of range.
    case backlight = "framing.hint.backlight"
    /// Player too small in the frame.
    case moveCloser = "framing.hint.move_closer"
    /// Nobody (or too little of the body) detected.
    case noPlayer = "framing.hint.no_player"
}

public struct FramingVerdict: Codable, Sendable, Hashable {
    public var isGreen: Bool
    public var hints: [FramingHint]
    /// Box height fraction used for the decision (nil without a candidate).
    public var heightFrac: Double?

    public init(isGreen: Bool, hints: [FramingHint], heightFrac: Double?) {
        self.isGreen = isGreen
        self.hints = hints
        self.heightFrac = heightFrac
    }
}

/// Live framing check on the 5 fps preview pose (DESIGN.md §5.4 step 0). Green requires all of:
/// ≥ 15 of 19 joints with c ≥ 0.3 including both ankles and both wrists; player height 40–70 % of the frame;
/// mean luma 0.25–0.85.
public enum LiveFraming {
    public static let minJoints = 15
    public static let minConfidence = 0.3
    public static let minHeight = 0.40
    public static let maxHeight = 0.70
    public static let minLuma = 0.25
    public static let maxLuma = 0.85

    /// - Parameters:
    ///   - player: the most prominent candidate in the preview frame (nil when nobody is detected).
    ///   - meanLuma: mean luma of the preview frame, 0…1.
    public static func evaluate(player: PersonCandidate?, meanLuma: Double) -> FramingVerdict {
        var hints: [FramingHint] = []
        let lumaOK = meanLuma.isFinite && meanLuma >= minLuma && meanLuma <= maxLuma
        guard let p = player else {
            hints.append(.noPlayer)
            if !lumaOK { hints.append(.backlight) }
            return FramingVerdict(isGreen: false, hints: hints, heightFrac: nil)
        }
        let visible = Joint.allCases.filter { (p.joints[$0]?.c ?? 0) >= minConfidence }
        let visibleSet = Set(visible)
        let extremitiesOK = [Joint.lAnk, .rAnk, .lWri, .rWri].allSatisfy { visibleSet.contains($0) }
        let jointsOK = visible.count >= minJoints && extremitiesOK
        let h = p.bbox.h
        let heightOK = h >= minHeight && h <= maxHeight

        if h > maxHeight { hints.append(.stepBack) }
        if !jointsOK { hints.append(.showFeet) }
        if h < minHeight { hints.append(.moveCloser) }
        if !lumaOK { hints.append(.backlight) }
        return FramingVerdict(isGreen: jointsOK && heightOK && lumaOK, hints: hints, heightFrac: h)
    }

    /// The preview candidate to judge: the largest box (the person nearest the camera).
    public static func mostProminent(_ candidates: [PersonCandidate]) -> PersonCandidate? {
        candidates.max { $0.bbox.area < $1.bbox.area }
    }
}
