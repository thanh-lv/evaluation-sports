import Foundation

/// A 2-D affine transform with Core Graphics field names (`x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`).
/// The app builds it from `AVAssetTrack.preferredTransform`; CoachCore stays free of CoreGraphics.
public struct VideoTransform: Codable, Sendable, Hashable {
    public var a: Double
    public var b: Double
    public var c: Double
    public var d: Double
    public var tx: Double
    public var ty: Double

    public init(a: Double, b: Double, c: Double, d: Double, tx: Double = 0, ty: Double = 0) {
        self.a = a
        self.b = b
        self.c = c
        self.d = d
        self.tx = tx
        self.ty = ty
    }

    public static let identity = VideoTransform(a: 1, b: 0, c: 0, d: 1)

    public var determinant: Double { a * d - b * c }
    /// Front-camera style mirrored source (det < 0).
    public var isMirrored: Bool { determinant < 0 }
}

/// EXIF / `CGImagePropertyOrientation` raw values.
public enum ImageOrientation: UInt32, Codable, Sendable, CaseIterable {
    case up = 1
    case upMirrored = 2
    case down = 3
    case downMirrored = 4
    case leftMirrored = 5
    case right = 6
    case rightMirrored = 7
    case left = 8
}

/// Orientation metadata from a track's `preferredTransform` (DESIGN.md §5.3).
///
/// Frames are rendered upright by the video composition, so Vision always runs with `.up`; this mapper is kept for
/// metadata, the `mirrored` payload flag and display-size computation. Mirrored rows are verified on device (M13).
public enum OrientationMapper {
    /// Rotation in quarter turns (0, 90, 180, 270 = −90), snapped to the nearest quarter.
    /// For a mirrored transform `M = R(θ)·flipX`, θ is recovered from `atan2(−b, −a)`.
    public static func rotationDegrees(_ t: VideoTransform) -> Int {
        let radians = t.isMirrored ? atan2(-t.b, -t.a) : atan2(t.b, t.a)
        guard radians.isFinite else { return 0 }
        let quarters = Int((radians * 2 / Double.pi).rounded())
        let normalized = ((quarters % 4) + 4) % 4
        return normalized * 90
    }

    /// 0° → up(1), 90° → right(6), 180° → down(3), −90° → left(8); mirrored → 2 / 7 / 4 / 5.
    public static func orientation(for t: VideoTransform) -> ImageOrientation {
        let degrees = rotationDegrees(t)
        if t.isMirrored {
            switch degrees {
            case 90: return .rightMirrored
            case 180: return .downMirrored
            case 270: return .leftMirrored
            default: return .upMirrored
            }
        }
        switch degrees {
        case 90: return .right
        case 180: return .down
        case 270: return .left
        default: return .up
        }
    }

    /// Raw EXIF value for the transform's (a, b, c, d) part.
    public static func exifOrientation(a: Double, b: Double, c: Double, d: Double) -> UInt32 {
        orientation(for: VideoTransform(a: a, b: b, c: c, d: d)).rawValue
    }

    public static func isMirrored(_ t: VideoTransform) -> Bool { t.isMirrored }

    /// Upright display size `|naturalSize.applying(t)|`, rounded to whole pixels.
    public static func displaySize(natural: PixelSize, transform t: VideoTransform) -> PixelSize {
        let w = Double(natural.w)
        let h = Double(natural.h)
        let dw = abs(t.a * w + t.c * h)
        let dh = abs(t.b * w + t.d * h)
        return PixelSize(w: safeInt(dw), h: safeInt(dh))
    }

    /// Composition render size: display size with the long edge capped (1920 by default). Scaled sizes are
    /// rounded to even numbers (friendlier to pixel-buffer pools); an unscaled size is returned unchanged.
    public static func renderSize(display: PixelSize, maxLongEdge: Int = 1920) -> PixelSize {
        let long = display.longEdge
        guard long > maxLongEdge, long > 0, maxLongEdge > 0 else { return display }
        let scale = Double(maxLongEdge) / Double(long)
        func even(_ v: Int) -> Int {
            let s = Double(v) * scale
            return max(2, 2 * safeInt(s / 2))
        }
        return PixelSize(w: even(display.w), h: even(display.h))
    }

    /// Scale factor from display size to render size (≤ 1).
    public static func renderScale(display: PixelSize, maxLongEdge: Int = 1920) -> Double {
        let long = display.longEdge
        guard long > maxLongEdge, long > 0 else { return 1 }
        return Double(maxLongEdge) / Double(long)
    }

    private static func safeInt(_ v: Double) -> Int {
        guard v.isFinite else { return 0 }
        return Int(v.rounded())
    }
}
