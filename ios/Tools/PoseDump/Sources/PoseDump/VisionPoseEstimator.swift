import CoachCore
import CoreVideo
import Foundation
import Vision

/// Vision body-pose adapter (same contract as the app's `VisionPoseEstimator`, DESIGN.md §5.2 Pose).
///
/// Reuses one `VNDetectHumanBodyPoseRequest`; frames are already upright, so orientation is always `.up`.
/// Points come back in Vision space (bottom-left origin, relative to `regionOfInterest` when one is set) and are
/// mapped to full-frame CFS with `RoiMapper`.
final class VisionPoseEstimator {
    private let request = VNDetectHumanBodyPoseRequest()
    private let roiRelative: Bool

    init(roiRelative: Bool) {
        self.roiRelative = roiRelative
    }

    /// People in the frame, as CoachCore candidates in full-frame CFS.
    /// - Parameters:
    ///   - cfsRoi: region to analyse (CFS, top-left origin); `.unit` for the full frame.
    ///   - aspect: display width / height.
    func detect(pixelBuffer: CVPixelBuffer, cfsRoi: Rect, aspect: Double) throws -> [PersonCandidate] {
        let roi = Self.sanitized(cfsRoi)
        let v = RoiMapper.visionRegion(fromCFS: roi)
        request.regionOfInterest = CGRect(x: v.x, y: v.y, width: v.w, height: v.h)
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
        try handler.perform([request])
        let observations = request.results ?? []

        var candidates: [PersonCandidate] = []
        for observation in observations {
            let points = try observation.recognizedPoints(.all)
            var joints: [Joint: Keypoint] = [:]
            for joint in Joint.allCases {
                guard let p = points[Self.visionName(joint)], p.confidence > 0 else { continue }
                let local = Point(x: Double(p.location.x), y: Double(p.location.y))
                let cfs = RoiMapper.cfsPoint(fromVisionPoint: local, cfsRoi: roi, roiRelative: roiRelative)
                joints[joint] = Keypoint(x: cfs.x, y: cfs.y, c: Double(p.confidence))
            }
            if let c = CandidateBuilder.build(joints: joints, aspect: aspect) {
                candidates.append(c)
            }
        }
        return candidates
    }

    /// Explicit mapping: Vision's raw joint identifiers are never persisted.
    static func visionName(_ joint: Joint) -> VNHumanBodyPoseObservation.JointName {
        switch joint {
        case .nose: return .nose
        case .lEye: return .leftEye
        case .rEye: return .rightEye
        case .lEar: return .leftEar
        case .rEar: return .rightEar
        case .neck: return .neck
        case .lSho: return .leftShoulder
        case .rSho: return .rightShoulder
        case .lElb: return .leftElbow
        case .rElb: return .rightElbow
        case .lWri: return .leftWrist
        case .rWri: return .rightWrist
        case .root: return .root
        case .lHip: return .leftHip
        case .rHip: return .rightHip
        case .lKne: return .leftKnee
        case .rKne: return .rightKnee
        case .lAnk: return .leftAnkle
        case .rAnk: return .rightAnkle
        }
    }

    /// Vision rejects a ROI outside the unit square or with zero size.
    private static func sanitized(_ r: Rect) -> Rect {
        guard r.isFinite else { return .unit }
        let c = r.clipped(to: .unit)
        return c.w > 0.01 && c.h > 0.01 ? c : .unit
    }
}
