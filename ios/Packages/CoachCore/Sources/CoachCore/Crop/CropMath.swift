import Foundation

/// Key-frame crop arithmetic (DESIGN-v1.0 §5.3 `Crop/`, DESIGN.md §5.4 step 8).
///
/// Server crops are normalized `{x, y, w, h}` in display space with a top-left origin. The app renders the full
/// frame at display (render) size, masks it, crops with `pixelRect`, then scales to `outputSize` (never upscaling)
/// and encodes a JPEG.
public enum CropMath {
    public static let defaultLongEdge = 768

    /// Integer pixel rect for a normalized crop inside an image of `display` size: origin floored, far edge ceiled,
    /// clamped to the image, at least 1×1. Non-finite crops fall back to the whole image.
    public static func pixelRect(crop: Rect, display: PixelSize) -> PixelRect {
        let W = max(display.w, 1)
        let H = max(display.h, 1)
        guard crop.isFinite else { return PixelRect(x: 0, y: 0, w: W, h: H) }
        let c = crop.clipped(to: .unit)
        func clampInt(_ v: Double, _ hi: Int) -> Int {
            guard v.isFinite else { return 0 }
            return Int(min(max(v, 0), Double(hi)))
        }
        // Small epsilon so that e.g. 0.38 × 1920 = 729.6000000000001 does not round outward by a whole pixel.
        let eps = 1e-6
        var x0 = clampInt((c.minX * Double(W) + eps).rounded(.down), W)
        var y0 = clampInt((c.minY * Double(H) + eps).rounded(.down), H)
        var x1 = clampInt((c.maxX * Double(W) - eps).rounded(.up), W)
        var y1 = clampInt((c.maxY * Double(H) - eps).rounded(.up), H)
        if x1 <= x0 {
            x0 = min(x0, W - 1)
            x1 = x0 + 1
        }
        if y1 <= y0 {
            y0 = min(y0, H - 1)
            y1 = y0 + 1
        }
        return PixelRect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
    }

    /// Output size with the long edge at most `longEdge`, aspect preserved, never upscaled, at least 1×1.
    public static func outputSize(for size: PixelSize, longEdge: Int = defaultLongEdge) -> PixelSize {
        let w = max(size.w, 1)
        let h = max(size.h, 1)
        let long = max(w, h)
        guard longEdge > 0, long > longEdge else { return PixelSize(w: w, h: h) }
        let scale = Double(longEdge) / Double(long)
        let ow = w >= h ? longEdge : max(1, Int((Double(w) * scale).rounded()))
        let oh = h > w ? longEdge : max(1, Int((Double(h) * scale).rounded()))
        return PixelSize(w: ow, h: oh)
    }

    /// The normalized crop actually covered by `pixelRect` (useful to map overlays exactly onto the crop image).
    public static func normalizedRect(of r: PixelRect, display: PixelSize) -> Rect {
        let W = Double(max(display.w, 1))
        let H = Double(max(display.h, 1))
        return Rect(x: Double(r.x) / W, y: Double(r.y) / H, w: Double(r.w) / W, h: Double(r.h) / H)
    }

    /// Maps a full-frame CFS point into pixel coordinates of a crop image of `imageSize` made from `crop`.
    public static func imagePoint(_ p: Point, crop: Rect, imageSize: PixelSize) -> Point {
        guard crop.w > 0, crop.h > 0 else { return .zero }
        return Point(x: (p.x - crop.x) / crop.w * Double(imageSize.w), y: (p.y - crop.y) / crop.h * Double(imageSize.h))
    }

    /// Image-capture tolerance in seconds: ±0.45 source frame (DESIGN.md §5.4 step 8).
    public static func toleranceSeconds(srcFps: Double) -> Double {
        guard srcFps.isFinite, srcFps > 0 else { return 0.45 / 30 }
        return 0.45 / srcFps
    }

    /// Whether a generated image's `actualTime` is acceptable (off by less than ½ source frame).
    public static func isActualTimeAcceptable(requestedUs: Int64, actualUs: Int64, srcFps: Double) -> Bool {
        let fps = (srcFps.isFinite && srcFps > 0) ? srcFps : 30
        let halfFrameUs = 500_000 / fps
        return Double(abs(actualUs - requestedUs)) < halfFrameUs
    }
}
