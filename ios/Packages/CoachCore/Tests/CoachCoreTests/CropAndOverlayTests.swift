import Foundation
import Testing
@testable import CoachCore

@Suite("CropMath")
struct CropMathTests {
    let display = PixelSize(w: 1920, h: 1080)

    @Test func pixelRectFloorsOriginAndCeilsEdge() {
        let r = CropMath.pixelRect(crop: Rect(x: 0.38, y: 0.09, w: 0.33, h: 0.62), display: display)
        // 0.38·1920 = 729.6 → 729; 0.71·1920 = 1363.2 → 1364; 0.09·1080 = 97.2 → 97; 0.71·1080 = 766.8 → 767
        #expect(r == PixelRect(x: 729, y: 97, w: 635, h: 670))
    }

    @Test func exactEdgesDoNotGrow() {
        #expect(CropMath.pixelRect(crop: Rect(x: 0.25, y: 0.5, w: 0.5, h: 0.5), display: display) == PixelRect(x: 480, y: 540, w: 960, h: 540))
        #expect(CropMath.pixelRect(crop: .unit, display: display) == PixelRect(x: 0, y: 0, w: 1920, h: 1080))
    }

    @Test func clampsAndHandlesDegenerateCrops() {
        #expect(CropMath.pixelRect(crop: Rect(x: 0.9, y: 0.9, w: 0.5, h: 0.5), display: display) == PixelRect(x: 1728, y: 972, w: 192, h: 108))
        let tiny = CropMath.pixelRect(crop: Rect(x: 1, y: 1, w: 0, h: 0), display: display)
        #expect(tiny.w == 1 && tiny.h == 1 && tiny.x == 1919 && tiny.y == 1079)
        #expect(CropMath.pixelRect(crop: Rect(x: .nan, y: 0, w: 1, h: 1), display: display) == PixelRect(x: 0, y: 0, w: 1920, h: 1080))
    }

    @Test func outputSizeNeverUpscales() {
        #expect(CropMath.outputSize(for: PixelSize(w: 635, h: 670)) == PixelSize(w: 635, h: 670))
        #expect(CropMath.outputSize(for: PixelSize(w: 1920, h: 1080)) == PixelSize(w: 768, h: 432))
        #expect(CropMath.outputSize(for: PixelSize(w: 960, h: 1280)) == PixelSize(w: 576, h: 768))
        #expect(CropMath.outputSize(for: PixelSize(w: 1000, h: 1000)) == PixelSize(w: 768, h: 768))
        #expect(CropMath.outputSize(for: PixelSize(w: 768, h: 100)) == PixelSize(w: 768, h: 100))
        #expect(CropMath.outputSize(for: PixelSize(w: 0, h: 0)) == PixelSize(w: 1, h: 1))
    }

    @Test func flippedYAndTolerance() {
        #expect(PixelRect(x: 10, y: 20, w: 30, h: 40).flippedY(imageHeight: 100) == PixelRect(x: 10, y: 40, w: 30, h: 40))
        #expect(abs(CropMath.toleranceSeconds(srcFps: 60) - 0.0075) < 1e-12)
        #expect(CropMath.isActualTimeAcceptable(requestedUs: 1_000_000, actualUs: 1_008_000, srcFps: 60))
        #expect(!CropMath.isActualTimeAcceptable(requestedUs: 1_000_000, actualUs: 1_008_400, srcFps: 60))
    }

    @Test func imagePointMapsIntoCrop() {
        let crop = Rect(x: 0.25, y: 0.5, w: 0.5, h: 0.25)
        let p = CropMath.imagePoint(Point(x: 0.5, y: 0.625), crop: crop, imageSize: PixelSize(w: 768, h: 216))
        #expect(abs(p.x - 384) < 1e-9 && abs(p.y - 108) < 1e-9)
    }
}

@Suite("Overlay")
struct OverlayTests {
    @Test func fourteenBonesConnectedTree() {
        let bones = SkeletonGeometry.bones
        #expect(bones.count == 14)
        #expect(Set(bones).count == 14)
        #expect(bones.allSatisfy { $0.from != $0.to })
        // 14 edges over the 15 non-face joints, all connected → a spanning tree.
        let nodes = Set(bones.flatMap(\.joints))
        #expect(nodes == Set(SkeletonGeometry.dotJoints))
        var seen: Set<Joint> = [.neck]
        var frontier: [Joint] = [.neck]
        while let j = frontier.popLast() {
            for b in bones where b.from == j || b.to == j {
                let other = b.from == j ? b.to : b.from
                if seen.insert(other).inserted { frontier.append(other) }
            }
        }
        #expect(seen == nodes)
        #expect(bones.contains(Bone(.neck, .root)) && bones.contains(Bone(.rKne, .rAnk)))
    }

    @Test func timelineInterpolatesAndHidesGaps() throws {
        let a: [Joint: Point] = [.nose: Point(x: 0.1, y: 0.2), .neck: Point(x: 0.1, y: 0.3)]
        let b: [Joint: Point] = [.nose: Point(x: 0.3, y: 0.4)]
        let c: [Joint: Point] = [.nose: Point(x: 0.5, y: 0.5)]
        let tl = PoseTimeline(tUs: [1_000_000, 1_050_000, 1_300_000], poses: [a, b, c])
        let mid = try #require(tl.pose(atUs: 1_025_000))
        let nose = try #require(mid[.nose])
        #expect(abs(nose.x - 0.2) < 1e-12 && abs(nose.y - 0.3) < 1e-12)
        #expect(mid[.neck] == nil) // missing on one side → hidden
        #expect(tl.pose(atUs: 1_000_000)?[.neck] == Point(x: 0.1, y: 0.3))
        #expect(tl.pose(atUs: 1_200_000) == nil) // 250 ms gap
        #expect(tl.pose(atUs: 1_300_000)?[.nose] == Point(x: 0.5, y: 0.5))
        #expect(tl.pose(atUs: 999_999) == nil)
        #expect(tl.pose(atUs: 1_300_001) == nil)
        #expect(tl.nearestIndex(atUs: 1_040_000) == 1)
        #expect(tl.nearestPose(atUs: 1_200_000, toleranceUs: 150_000)?[.nose] == Point(x: 0.5, y: 0.5))
        #expect(tl.nearestPose(atUs: 1_150_000, toleranceUs: 50_000) == nil)
    }

    @Test func timelineSkipsNonIncreasingTimes() {
        let tl = PoseTimeline(tUs: [10, 10, 5, 20], poses: [[:], [:], [:], [:]])
        #expect(tl.tUs == [10, 20])
    }

    @Test func timelineFromPoseFixture() throws {
        let pose = try JSONDecoder().decode(PoseV1.self, from: try Fixtures.data("pose/synthetic_minimal.json"))
        let tl = PoseTimeline(pose: pose)
        #expect(tl.tUs == pose.track.tUs)
        let t = pose.track.tUs[10]
        let p = try #require(tl.pose(atUs: t))
        let raw = pose.track.joints(at: 10)
        #expect(p.count == raw.count)
        #expect(p[.nose] == raw[.nose]?.point)
    }

    @Test func keyFrameSkeletonMapsIntoCropPixels() throws {
        let pose: [Joint: Point] = [
            .lSho: Point(x: 0.5, y: 0.5), .lElb: Point(x: 0.6, y: 0.5), .lWri: Point(x: 0.7, y: 0.5),
            .nose: Point(x: 0.5, y: 0.3),
        ]
        let crop = Rect(x: 0.4, y: 0.25, w: 0.4, h: 0.5)
        let sk = KeyFrameSkeleton.make(pose: pose, crop: crop, imageSize: PixelSize(w: 400, h: 500), highlight: [.lElb, .lWri])
        #expect(sk.segments.count == 2) // lSho–lElb, lElb–lWri
        let forearm = try #require(sk.segments.first { $0.bone == Bone(.lElb, .lWri) })
        #expect(forearm.highlighted)
        #expect(abs(forearm.a.x - 200) < 1e-9 && abs(forearm.a.y - 250) < 1e-9)
        #expect(abs(forearm.b.x - 300) < 1e-9)
        #expect(sk.segments.first { $0.bone == Bone(.lSho, .lElb) }?.highlighted == false)
        #expect(sk.dots.count == 4)
        #expect(sk.dots.filter(\.highlighted).map(\.joint).sorted { $0.index < $1.index } == [.lElb, .lWri])
    }

    @Test func keyFrameSkeletonFromRequest() throws {
        let pose = try JSONDecoder().decode(PoseV1.self, from: try Fixtures.data("pose/synthetic_minimal.json"))
        let tl = PoseTimeline(pose: pose)
        let req = FrameRequest(frameId: .F3, strokeId: 1, phase: .contact, tUs: pose.track.tUs[40], crop: Rect(x: 0.2, y: 0.1, w: 0.6, h: 0.8), upload: true)
        let sk = try #require(KeyFrameSkeleton.make(timeline: tl, request: req, imageSize: PixelSize(w: 576, h: 432), highlight: [.rElb]))
        #expect(!sk.isEmpty)
        #expect(KeyFrameSkeleton.make(timeline: tl, tUs: 99_000_000, crop: .unit, imageSize: PixelSize(w: 10, h: 10)) == nil)
    }
}
