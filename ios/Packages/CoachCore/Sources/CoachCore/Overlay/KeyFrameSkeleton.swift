import Foundation

/// Skeleton geometry for a cropped key-frame image (`KeyFrameView`, DESIGN.md §5.2 Results).
///
/// Input poses are full-frame CFS (0…1); output points are pixels of the crop image (top-left origin), so the view
/// can draw them directly over the image scaled to `imageSize`. Joints named by the evidence are highlighted.
public struct KeyFrameSkeleton: Sendable, Hashable {
    public struct Segment: Sendable, Hashable {
        public var bone: Bone
        public var a: Point
        public var b: Point
        /// Both ends are highlighted joints.
        public var highlighted: Bool

        public init(bone: Bone, a: Point, b: Point, highlighted: Bool) {
            self.bone = bone
            self.a = a
            self.b = b
            self.highlighted = highlighted
        }
    }

    public struct Dot: Sendable, Hashable {
        public var joint: Joint
        public var point: Point
        public var highlighted: Bool

        public init(joint: Joint, point: Point, highlighted: Bool) {
            self.joint = joint
            self.point = point
            self.highlighted = highlighted
        }
    }

    public var segments: [Segment]
    public var dots: [Dot]
    public var imageSize: PixelSize

    public init(segments: [Segment], dots: [Dot], imageSize: PixelSize) {
        self.segments = segments
        self.dots = dots
        self.imageSize = imageSize
    }

    public var isEmpty: Bool { segments.isEmpty && dots.isEmpty }

    /// - Parameters:
    ///   - pose: full-frame CFS joints.
    ///   - crop: the frame request's crop (the same rect used to cut the image).
    ///   - imageSize: pixel size of the cropped image as displayed or stored.
    ///   - highlight: joints to emphasise (evidence / hero `joints`).
    public static func make(pose: [Joint: Point], crop: Rect, imageSize: PixelSize, highlight: Set<Joint> = []) -> KeyFrameSkeleton {
        var mapped: [Joint: Point] = [:]
        for (j, p) in pose where p.x.isFinite && p.y.isFinite {
            mapped[j] = CropMath.imagePoint(p, crop: crop, imageSize: imageSize)
        }
        var segments: [Segment] = []
        for bone in SkeletonGeometry.bones {
            guard let a = mapped[bone.from], let b = mapped[bone.to] else { continue }
            let hl = highlight.contains(bone.from) && highlight.contains(bone.to)
            segments.append(Segment(bone: bone, a: a, b: b, highlighted: hl))
        }
        var dots: [Dot] = []
        for j in SkeletonGeometry.dotJoints {
            guard let p = mapped[j] else { continue }
            dots.append(Dot(joint: j, point: p, highlighted: highlight.contains(j)))
        }
        return KeyFrameSkeleton(segments: segments, dots: dots, imageSize: imageSize)
    }

    /// Skeleton at a frame request time from a timeline (nearest sampled frame, since `tUs` is a sampled PTS).
    public static func make(
        timeline: PoseTimeline,
        tUs: Int64,
        crop: Rect,
        imageSize: PixelSize,
        highlight: Set<Joint> = []
    ) -> KeyFrameSkeleton? {
        guard let pose = timeline.pose(atUs: tUs) ?? timeline.nearestPose(atUs: tUs) else { return nil }
        return make(pose: pose, crop: crop, imageSize: imageSize, highlight: highlight)
    }

    /// Convenience for a frame request plus evidence joints.
    public static func make(
        timeline: PoseTimeline,
        request: FrameRequest,
        imageSize: PixelSize,
        highlight: [Joint] = []
    ) -> KeyFrameSkeleton? {
        make(timeline: timeline, tUs: request.tUs, crop: request.crop, imageSize: imageSize, highlight: Set(highlight))
    }
}
