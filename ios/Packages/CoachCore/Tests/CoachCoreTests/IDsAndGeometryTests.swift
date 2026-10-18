import Foundation
import Testing
@testable import CoachCore

@Suite("IDs")
struct IDsTests {
    @Test func lowercasesUUID() throws {
        let id = try #require(UUID(uuidString: "0B0C4F1E-5A8D-4C47-9B1E-6C1F2A3B4C5D"))
        #expect(IDs.lower(id) == "0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d")
    }

    @Test func parsesAnyCaseText() {
        #expect(IDs.lower("0B0C4F1E-5a8d-4C47-9B1E-6C1F2A3B4C5D") == "0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d")
        #expect(IDs.lower("not-a-uuid") == nil)
        #expect(IDs.lower("") == nil)
    }

    @Test func canonicalCheckAndNewIds() {
        #expect(IDs.isLowerCanonical("0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d"))
        #expect(!IDs.isLowerCanonical("0B0C4F1E-5A8D-4C47-9B1E-6C1F2A3B4C5D"))
        let fresh = IDs.newId()
        #expect(fresh == fresh.lowercased())
        #expect(IDs.isLowerCanonical(fresh))
    }

    @Test func requestBodiesLowercase() throws {
        let id = try #require(UUID(uuidString: "0B0C4F1E-5A8D-4C47-9B1E-6C1F2A3B4C5D"))
        #expect(SubmitRequest(analysisId: id).analysisId == "0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d")
        #expect(ReprepareV1(analysisId: id, cameraView: .side, excludedStrokeIds: [], handedness: .right).analysisId == IDs.lower(id))
    }
}

@Suite("OrientationMapper")
struct OrientationTests {
    struct Row: Sendable {
        let a: Double, b: Double, c: Double, d: Double
        let expected: ImageOrientation
        let degrees: Int
        let mirrored: Bool
    }

    // Non-mirrored rows are R(θ); mirrored rows are R(θ)·flipX = [[-cosθ, -sinθ], [-sinθ, cosθ]] (a, c / b, d).
    static let table: [Row] = [
        Row(a: 1, b: 0, c: 0, d: 1, expected: .up, degrees: 0, mirrored: false),
        Row(a: 0, b: 1, c: -1, d: 0, expected: .right, degrees: 90, mirrored: false),
        Row(a: -1, b: 0, c: 0, d: -1, expected: .down, degrees: 180, mirrored: false),
        Row(a: 0, b: -1, c: 1, d: 0, expected: .left, degrees: 270, mirrored: false),
        Row(a: -1, b: 0, c: 0, d: 1, expected: .upMirrored, degrees: 0, mirrored: true),
        Row(a: 0, b: -1, c: -1, d: 0, expected: .rightMirrored, degrees: 90, mirrored: true),
        Row(a: 1, b: 0, c: 0, d: -1, expected: .downMirrored, degrees: 180, mirrored: true),
        Row(a: 0, b: 1, c: 1, d: 0, expected: .leftMirrored, degrees: 270, mirrored: true),
    ]

    @Test(arguments: OrientationTests.table)
    func orientationTable(row: Row) {
        let t = VideoTransform(a: row.a, b: row.b, c: row.c, d: row.d)
        #expect(OrientationMapper.orientation(for: t) == row.expected)
        #expect(OrientationMapper.rotationDegrees(t) == row.degrees)
        #expect(OrientationMapper.isMirrored(t) == row.mirrored)
        #expect(OrientationMapper.exifOrientation(a: row.a, b: row.b, c: row.c, d: row.d) == row.expected.rawValue)
    }

    @Test func exifRawValues() {
        #expect(ImageOrientation.up.rawValue == 1)
        #expect(ImageOrientation.right.rawValue == 6)
        #expect(ImageOrientation.down.rawValue == 3)
        #expect(ImageOrientation.left.rawValue == 8)
        #expect([ImageOrientation.upMirrored, .rightMirrored, .downMirrored, .leftMirrored].map(\.rawValue) == [2, 7, 4, 5])
    }

    @Test func nearlyRotatedSnapsToQuarter() {
        let t = VideoTransform(a: 0.0001, b: 1, c: -1, d: 0.0001)
        #expect(OrientationMapper.orientation(for: t) == .right)
    }

    @Test func displayAndRenderSize() {
        let natural = PixelSize(w: 1920, h: 1080)
        let portrait = VideoTransform(a: 0, b: 1, c: -1, d: 0, tx: 1080, ty: 0)
        #expect(OrientationMapper.displaySize(natural: natural, transform: portrait) == PixelSize(w: 1080, h: 1920))
        #expect(OrientationMapper.displaySize(natural: natural, transform: .identity) == natural)
        #expect(OrientationMapper.renderSize(display: PixelSize(w: 3840, h: 2160)) == PixelSize(w: 1920, h: 1080))
        #expect(OrientationMapper.renderSize(display: PixelSize(w: 2160, h: 3840)) == PixelSize(w: 1080, h: 1920))
        #expect(OrientationMapper.renderSize(display: PixelSize(w: 1080, h: 1920)) == PixelSize(w: 1080, h: 1920))
        #expect(OrientationMapper.renderScale(display: PixelSize(w: 3840, h: 2160)) == 0.5)
    }
}

@Suite("RoiMapper")
struct RoiMapperTests {
    @Test func visionRegionFlipsY() {
        let cfs = Rect(x: 0.2, y: 0.1, w: 0.4, h: 0.5)
        let v = RoiMapper.visionRegion(fromCFS: cfs)
        #expect(abs(v.y - 0.4) < 1e-12)
        let back = RoiMapper.cfsRegion(fromVision: v)
        #expect(abs(back.y - cfs.y) < 1e-12 && back.x == cfs.x && back.w == cfs.w && back.h == cfs.h)
    }

    @Test func roiRelativePointRoundTrip() {
        let roi = Rect(x: 0.25, y: 0.1, w: 0.5, h: 0.6)
        // Centre of the ROI in Vision ROI coordinates is the centre of the ROI in CFS.
        let centre = RoiMapper.cfsPoint(fromVisionPoint: Point(x: 0.5, y: 0.5), cfsRoi: roi)
        #expect(abs(centre.x - 0.5) < 1e-12 && abs(centre.y - 0.4) < 1e-12)
        // Vision ROI (0, 1) is the ROI's top-left corner in CFS.
        let topLeft = RoiMapper.cfsPoint(fromVisionPoint: Point(x: 0, y: 1), cfsRoi: roi)
        #expect(abs(topLeft.x - 0.25) < 1e-12 && abs(topLeft.y - 0.1) < 1e-12)
        for p in [Point(x: 0.1, y: 0.9), Point(x: 0.7, y: 0.3), Point(x: 0.5, y: 0.5)] {
            let back = RoiMapper.visionPoint(fromCFSPoint: RoiMapper.cfsPoint(fromVisionPoint: p, cfsRoi: roi), cfsRoi: roi)
            #expect(abs(back.x - p.x) < 1e-12 && abs(back.y - p.y) < 1e-12)
        }
    }

    @Test func absoluteModeOnlyFlips() {
        let p = RoiMapper.cfsPoint(fromVisionPoint: Point(x: 0.3, y: 0.8), cfsRoi: Rect(x: 0.5, y: 0.5, w: 0.1, h: 0.1), roiRelative: false)
        #expect(abs(p.x - 0.3) < 1e-12 && abs(p.y - 0.2) < 1e-12)
    }
}
