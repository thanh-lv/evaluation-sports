import AVFoundation
import CoachCore
import CoreVideo
import Foundation

struct ReaderError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Asset facts needed for the payload.
struct AssetInfo {
    let track: AVAssetTrack
    let duration: CMTime
    let naturalSize: CGSize
    let preferredTransform: CGAffineTransform
    let nominalFps: Double

    var transform: VideoTransform {
        let t = preferredTransform
        return VideoTransform(a: Double(t.a), b: Double(t.b), c: Double(t.c), d: Double(t.d), tx: Double(t.tx), ty: Double(t.ty))
    }

    var displaySize: PixelSize {
        OrientationMapper.displaySize(
            natural: PixelSize(w: Int(naturalSize.width.rounded()), h: Int(naturalSize.height.rounded())),
            transform: transform
        )
    }

    var renderSize: PixelSize { OrientationMapper.renderSize(display: displaySize) }
    var mirrored: Bool { transform.isMirrored }
    var durationMs: Int64 {
        guard duration.isValid, duration.timescale > 0 else { return 0 }
        return (Timebase.microseconds(value: duration.value, timescale: duration.timescale) ?? 0) / 1000
    }

    static func load(_ asset: AVURLAsset) async throws -> AssetInfo {
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw ReaderError("no video track in \(asset.url.lastPathComponent)")
        }
        let (naturalSize, transform, fps) = try await track.load(.naturalSize, .preferredTransform, .nominalFrameRate)
        let duration = try await asset.load(.duration)
        return AssetInfo(track: track, duration: duration, naturalSize: naturalSize, preferredTransform: transform, nominalFps: Double(fps))
    }
}

/// Sequential upright SDR decode (DESIGN.md §5.2 Video `CompositionFrameReader`, §5.4 step 2).
///
/// `AVAssetReaderVideoCompositionOutput` with a composition that applies `preferredTransform` (frames come out upright
/// in display space, so Vision runs with `.up`), Rec.709 colour properties (HLG / Dolby Vision tone-mapped to SDR),
/// render size = display size with the long edge capped at 1920, and frame timing taken from the source track so
/// PTS are the clip's own (VFR preserved). Timestamps are returned in µs on the asset timeline.
final class CompositionFrameReader {
    private let reader: AVAssetReader
    private let output: AVAssetReaderVideoCompositionOutput

    init(asset: AVAsset, info: AssetInfo, startMs: Int64, endMs: Int64) throws {
        let render = info.renderSize
        let scale = OrientationMapper.renderScale(display: info.displaySize)

        let composition = AVMutableVideoComposition()
        composition.renderSize = CGSize(width: render.w, height: render.h)
        let fps = info.nominalFps.isFinite && info.nominalFps > 0 ? info.nominalFps : 30
        composition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(min(max(fps.rounded(), 1), 240)))
        composition.sourceTrackIDForFrameTiming = info.track.trackID
        composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2

        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: info.duration)
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: info.track)
        // preferredTransform already includes the translation that keeps the rotated frame in positive space;
        // concatenating the scale afterwards scales that translation too.
        layer.setTransform(info.preferredTransform.concatenating(CGAffineTransform(scaleX: scale, y: scale)), at: .zero)
        instruction.layerInstructions = [layer]
        composition.instructions = [instruction]

        reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output = AVAssetReaderVideoCompositionOutput(videoTracks: [info.track], videoSettings: settings)
        output.videoComposition = composition
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw ReaderError("cannot add the composition output to the reader") }
        reader.add(output)
        reader.timeRange = CMTimeRange(start: CMTime(value: startMs, timescale: 1000), end: CMTime(value: endMs, timescale: 1000))
        guard reader.startReading() else {
            throw ReaderError("reader failed to start: \(reader.error.map { "\($0)" } ?? "unknown error")")
        }
    }

    /// Calls `body` for each decoded frame with its PTS in µs, inside an autorelease pool. The pixel buffer must not
    /// be retained after `body` returns. Return false from `body` to stop early.
    func forEachFrame(_ body: (Int64, CVPixelBuffer) throws -> Bool) throws {
        while true {
            let keepGoing: Bool = try autoreleasepool {
                guard let sample = output.copyNextSampleBuffer() else { return false }
                let pts = CMSampleBufferGetPresentationTimeStamp(sample)
                guard pts.isValid, let us = Timebase.microseconds(value: pts.value, timescale: pts.timescale),
                      let buffer = CMSampleBufferGetImageBuffer(sample)
                else { return true }
                return try body(us, buffer)
            }
            if !keepGoing { break }
        }
        if reader.status == .failed {
            throw ReaderError("decode failed: \(reader.error.map { "\($0)" } ?? "unknown error")")
        }
    }

    func cancel() {
        reader.cancelReading()
    }
}
