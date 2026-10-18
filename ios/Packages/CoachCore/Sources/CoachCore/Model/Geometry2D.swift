import Foundation

/// A 2-D point. In CoachCore, "CFS" points are normalized to 0…1 with the origin at the top-left of the upright
/// display frame (the wire format scales this to integer 0…1000, see `Quantizer`).
public struct Point: Codable, Sendable, Hashable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public static let zero = Point(x: 0, y: 0)

    public func distance(to other: Point) -> Double {
        let dx = x - other.x
        let dy = y - other.y
        return (dx * dx + dy * dy).squareRoot()
    }

    /// Linear interpolation, `t` = 0 → self, 1 → other.
    public func lerp(to other: Point, _ t: Double) -> Point {
        Point(x: x + (other.x - x) * t, y: y + (other.y - y) * t)
    }
}

/// An axis-aligned rectangle `{x, y, w, h}`, origin top-left. Used for CFS-normalized boxes, ROIs and the
/// contract `NormRect` (frame-request crops), whose JSON keys are exactly `x`, `y`, `w`, `h`.
public struct Rect: Codable, Sendable, Hashable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }

    /// The whole normalized frame.
    public static let unit = Rect(x: 0, y: 0, w: 1, h: 1)

    public var minX: Double { x }
    public var minY: Double { y }
    public var maxX: Double { x + w }
    public var maxY: Double { y + h }
    public var center: Point { Point(x: x + w / 2, y: y + h / 2) }
    public var area: Double { max(0, w) * max(0, h) }
    public var isEmpty: Bool { !(w > 0 && h > 0) }

    public init(center: Point, w: Double, h: Double) {
        self.init(x: center.x - w / 2, y: center.y - h / 2, w: w, h: h)
    }

    /// Smallest rect containing all points; nil for an empty list.
    public init?(bounding points: [Point]) {
        guard let first = points.first else { return nil }
        var lo = first
        var hi = first
        for p in points.dropFirst() {
            lo.x = min(lo.x, p.x)
            lo.y = min(lo.y, p.y)
            hi.x = max(hi.x, p.x)
            hi.y = max(hi.y, p.y)
        }
        self.init(x: lo.x, y: lo.y, w: hi.x - lo.x, h: hi.y - lo.y)
    }

    public func contains(_ p: Point) -> Bool {
        p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
    }

    public func intersection(_ o: Rect) -> Rect? {
        let x0 = max(minX, o.minX)
        let y0 = max(minY, o.minY)
        let x1 = min(maxX, o.maxX)
        let y1 = min(maxY, o.maxY)
        guard x1 > x0, y1 > y0 else { return nil }
        return Rect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
    }

    public func union(_ o: Rect) -> Rect {
        let x0 = min(minX, o.minX)
        let y0 = min(minY, o.minY)
        let x1 = max(maxX, o.maxX)
        let y1 = max(maxY, o.maxY)
        return Rect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
    }

    /// Intersection over union; 0 when either rect is empty.
    public func iou(_ o: Rect) -> Double {
        guard let inter = intersection(o) else { return 0 }
        let u = area + o.area - inter.area
        return u > 0 ? inter.area / u : 0
    }

    /// Scaled about the centre.
    public func scaled(by factor: Double) -> Rect {
        Rect(center: center, w: w * factor, h: h * factor)
    }

    public func offsetBy(dx: Double, dy: Double) -> Rect {
        Rect(x: x + dx, y: y + dy, w: w, h: h)
    }

    /// Clipped to `bounds` (may become empty).
    public func clipped(to bounds: Rect = .unit) -> Rect {
        intersection(bounds) ?? Rect(x: min(max(x, bounds.minX), bounds.maxX), y: min(max(y, bounds.minY), bounds.maxY), w: 0, h: 0)
    }

    /// Moved (not shrunk) to lie inside `bounds` where possible; dimensions larger than `bounds` are capped.
    public func shiftedInside(_ bounds: Rect = .unit) -> Rect {
        let nw = min(w, bounds.w)
        let nh = min(h, bounds.h)
        let nx = min(max(x, bounds.minX), bounds.maxX - nw)
        let ny = min(max(y, bounds.minY), bounds.maxY - nh)
        return Rect(x: nx, y: ny, w: nw, h: nh)
    }

    /// True when every component is a finite number.
    public var isFinite: Bool { x.isFinite && y.isFinite && w.isFinite && h.isFinite }
}

/// Integer pixel dimensions.
public struct PixelSize: Codable, Sendable, Hashable {
    public var w: Int
    public var h: Int

    public init(w: Int, h: Int) {
        self.w = w
        self.h = h
    }

    /// Width / height; 1 for a degenerate size.
    public var aspect: Double { h > 0 && w > 0 ? Double(w) / Double(h) : 1 }
    public var longEdge: Int { max(w, h) }
}

/// Integer pixel rectangle, origin top-left.
public struct PixelRect: Codable, Sendable, Hashable {
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int

    public init(x: Int, y: Int, w: Int, h: Int) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }

    public var size: PixelSize { PixelSize(w: w, h: h) }

    /// The same rect with a bottom-left origin inside an image of height `imageHeight` (Core Image convention).
    public func flippedY(imageHeight: Int) -> PixelRect {
        PixelRect(x: x, y: imageHeight - y - h, w: w, h: h)
    }
}
