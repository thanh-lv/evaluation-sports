import Foundation

/// Wire quantization for `pose.v1` (contracts `CFS_MAX` = 1000, `CONF_MAX` = 100).
///
/// x, y (CFS 0…1) → integers 0…1000; c (0…1) → integers 0…100; a joint with c < 0.3 is sent as `0,0,0` (missing).
/// Non-finite input is treated as missing / 0 so that bad Vision output can never trap on `Int(_:)`.
public enum Quantizer {
    public static let cfsMax = 1000
    public static let confMax = 100
    public static let minConfidence = 0.3
    /// 19 joints × (x, y, c).
    public static let valuesPerFrame = Joint.count * 3

    public static func coordinate(_ v: Double) -> Int { scaled(v, by: cfsMax) }
    public static func confidence(_ c: Double) -> Int { scaled(c, by: confMax) }

    /// `[x, y, c]` for one joint; `[0, 0, 0]` when missing or below the confidence threshold.
    public static func keypoint(_ k: Keypoint?) -> [Int] {
        guard let k, k.x.isFinite, k.y.isFinite, k.c.isFinite, k.c >= minConfidence else { return [0, 0, 0] }
        let c = confidence(k.c)
        // c ≥ 0.3 always quantizes to ≥ 30, so a present joint is never mistaken for the missing triple.
        return [coordinate(k.x), coordinate(k.y), c]
    }

    /// The 57-int row for one frame in `jointOrder`; all zeros when `joints` is nil.
    public static func frame(_ joints: [Joint: Keypoint]?) -> [Int] {
        var row: [Int] = []
        row.reserveCapacity(valuesPerFrame)
        for j in Joint.allCases {
            row.append(contentsOf: keypoint(joints?[j]))
        }
        return row
    }

    /// `[x, y, w, h]` in 0…1000 for a CFS box (clipped to the frame first).
    public static func box(_ r: Rect) -> [Int] {
        guard r.isFinite else { return [0, 0, 0, 0] }
        let c = r.clipped(to: .unit)
        return [coordinate(c.x), coordinate(c.y), coordinate(c.w), coordinate(c.h)]
    }

    // MARK: - Inverse

    /// Keypoint from a wire triple; nil for the missing triple (c == 0) or out-of-range values.
    public static func dequantize(x: Int, y: Int, c: Int) -> Keypoint? {
        guard c > 0, (0...confMax).contains(c), (0...cfsMax).contains(x), (0...cfsMax).contains(y) else { return nil }
        return Keypoint(x: Double(x) / Double(cfsMax), y: Double(y) / Double(cfsMax), c: Double(c) / Double(confMax))
    }

    /// Joints from a 57-value row (ints or floats, e.g. a clean track's float CFS); invalid rows give an empty map.
    public static func joints(fromRow row: [Double]) -> [Joint: Keypoint] {
        guard row.count == valuesPerFrame else { return [:] }
        var out: [Joint: Keypoint] = [:]
        for j in Joint.allCases {
            let base = j.index * 3
            let x = row[base], y = row[base + 1], c = row[base + 2]
            guard x.isFinite, y.isFinite, c.isFinite, c > 0 else { continue }
            out[j] = Keypoint(x: x / Double(cfsMax), y: y / Double(cfsMax), c: min(c / Double(confMax), 1))
        }
        return out
    }

    public static func joints(fromRow row: [Int]) -> [Joint: Keypoint] {
        joints(fromRow: row.map { Double($0) })
    }

    /// CFS box from a wire `[x, y, w, h]`.
    public static func rect(fromBox b: [Int]) -> Rect? {
        guard b.count == 4 else { return nil }
        let s = Double(cfsMax)
        return Rect(x: Double(b[0]) / s, y: Double(b[1]) / s, w: Double(b[2]) / s, h: Double(b[3]) / s)
    }

    private static func scaled(_ v: Double, by maxValue: Int) -> Int {
        guard v.isFinite else { return 0 }
        let clamped = min(max(v, 0), 1)
        // Half away from zero, like JS Math.round for non-negative values.
        return Int((clamped * Double(maxValue)).rounded())
    }
}
