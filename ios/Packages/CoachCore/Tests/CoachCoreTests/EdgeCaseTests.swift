import Foundation
import Testing
@testable import CoachCore

// Edge cases found in review: degenerate boxes on the wire, every prepare fixture decoded by value, NTSC frame
// rates, server rules mirrored by `PoseV1.validate()`, negative PTS rounding and scheduler resume.

private let aspect = 16.0 / 9.0
private let frameUs: Int64 = 33_333

@Suite("Review edge cases")
struct EdgeCaseTests {
    static let client = PoseV1.Client(app: "1.0.0", build: "1", os: "iOS 18.6", device: "iPhone16,1")
    static let session = PoseV1.Session(
        sport: .pickleball, skill: "pb.dink", handedness: .left, level: .beginner, cameraView: .side,
        subject: .other, subjectConsent: true, subjectMinor: true, language: .en
    )
    static let video = PoseV1.Video(
        source: .imported, durationMs: 5_000, segment: .init(startMs: 0, endMs: 5_000), srcFps: 30,
        analysisHz: 30, display: .init(w: 1080, h: 1920), mirrored: true
    )

    @Test func coastingPredictionLeavingTheFrameKeepsANonEmptyBox() throws {
        // The target runs out of the left edge fast; the constant-velocity prediction leaves the frame entirely.
        func at(_ i: Int) -> PersonCandidate { syntheticCandidate(cx: 0.3 - 0.08 * Double(i), cy: 0.5, height: 0.4) }
        var tracker = Tracker(initial: at(0), tUs: 0, aspect: aspect)
        var b = PoseV1Builder(analysisId: UUID(), client: Self.client, session: Self.session, video: Self.video)
        b.append(tUs: 0, target: at(0), box: at(0).bbox, flags: [])
        var acc = QualityAccumulator()
        acc.add(tUs: 0, target: at(0))
        for i in 1...2 {
            let cands = [at(i)]
            let step = tracker.step(tUs: Int64(i) * frameUs, candidates: cands)
            #expect(step.index == 0)
            b.append(tUs: Int64(i) * frameUs, step: step, candidates: cands)
            acc.add(tUs: Int64(i) * frameUs, step: step, candidates: cands)
        }
        for i in 3...40 {
            let step = tracker.step(tUs: Int64(i) * frameUs, candidates: [])
            #expect(step.index == nil)
            if let box = step.box {
                #expect(!box.isEmpty, "frame \(i): coasted box \(box) is empty")
                #expect(box.minX >= 0 && box.maxX <= 1 + 1e-12)
            }
            b.append(tUs: Int64(i) * frameUs, step: step, candidates: [])
            acc.add(tUs: Int64(i) * frameUs, step: step, candidates: [])
        }
        let pose = try b.build(quality: acc.stats)
        #expect(pose.validate().isEmpty, "\(pose.validate())")
        for (i, box) in pose.track.bbox.enumerated() {
            #expect(box[2] > 0 && box[3] > 0, "bbox[\(i)] = \(box) is degenerate")
        }
        // The quality gate rejects this clip (target lost), but the payload itself stays well-formed.
        #expect(QualityGate.evaluate(acc.stats).rejections.contains(.targetLost))
    }

    @Test func builderTreatsEmptyOrOffFrameBoxesAsUnknown() throws {
        var b = PoseV1Builder(analysisId: UUID(), client: Self.client, session: Self.session, video: Self.video)
        let p = syntheticCandidate(cx: 0.5, cy: 0.5, height: 0.5)
        b.append(tUs: 0, target: nil, box: Rect(x: 0.2, y: 0.2, w: 0, h: 0.3), flags: .coasted)
        b.append(tUs: 33_333, target: nil, box: Rect(x: 1.5, y: 0.2, w: 0.3, h: 0.3), flags: .coasted)
        b.append(tUs: 66_667, target: p, box: p.bbox, flags: [])
        b.append(tUs: 100_000, target: nil, box: Rect(x: .nan, y: 0, w: 1, h: 1), flags: .coasted)
        let pose = try b.build(quality: QualityAccumulator().stats)
        let expected = Quantizer.box(p.bbox)
        #expect(pose.track.bbox == [expected, expected, expected, expected])
    }

    @Test(arguments: Fixtures.jsonFiles(in: "prepare"))
    func everyPrepareFixtureDecodesByValue(url: URL) throws {
        let r = try roundTrip(PrepareResponseV1.self, try Data(contentsOf: url))
        #expect(r.original == r.again)
        #expect(r.fixturePaths == r.encodedPaths, "\(url.lastPathComponent): \(r.fixturePaths.symmetricDifference(r.encodedPaths))")
        let p = r.original
        #expect(p.schema == PrepareResponseV1.schemaId && p.status == .prepared)
        #expect(IDs.isLowerCanonical(p.analysisId))
        #expect(!p.strokes.isEmpty && p.strokes.count <= 12)
        for s in p.strokes {
            #expect(s.tStartUs <= s.tContactUs && s.tContactUs <= s.tEndUs)
            #expect(!s.excluded || s.role == nil)
        }
        for f in p.frameRequests {
            #expect(f.frameId.isUploadId || !f.upload, "\(f.frameId) must stay on device")
            #expect((f.frameId == .F5) == (f.phase == .overview))
            #expect(p.stroke(id: f.strokeId) != nil)
            #expect(f.crop.w > 0 && f.crop.h > 0 && f.crop.maxX <= 1 + 1e-9 && f.crop.maxY <= 1 + 1e-9)
            if p.frameMode == .poseOnly { #expect(!f.upload) }
            // The crop always maps to a non-empty pixel rect of the render size.
            let px = CropMath.pixelRect(crop: f.crop, display: PixelSize(w: 1920, h: 1080))
            #expect(px.w >= 1 && px.h >= 1)
        }
    }

    @Test func ntscFrameRates() {
        #expect(RateChooser.sourceFpsVerdict(23.976) == .warn) // "24p" is not rejected
        #expect(RateChooser.sourceFpsVerdict(24) == .warn)
        #expect(RateChooser.sourceFpsVerdict(23.9) == .reject)
        #expect(RateChooser.sourceFpsVerdict(15) == .reject)
        #expect(RateChooser.sourceFpsVerdict(29.97) == .warn) // matches the server's fps_low (< 30)
        #expect(RateChooser.sourceFpsVerdict(-1) == .reject)
        #expect(QualityGate.evaluate(
            QualityStats(framesTotal: 10, framesWithTarget: 10, meanLimbConf: 0.8, playerHeightFracMedian: 0.5, missingPct: 0, trackResets: 0, ambiguousAtMs: []),
            srcFps: 23.976
        ).passed)
    }

    @Test func validateMirrorsMoreServerRules() throws {
        let data = try Fixtures.data("pose/synthetic_minimal.json")
        let base = try JSONDecoder().decode(PoseV1.self, from: data)
        #expect(base.validate().isEmpty)

        var badSkill = base
        badSkill.session.skill = "bd.Clear-FH"
        #expect(badSkill.validate().contains { $0.contains("bd.<skill>") })

        var negativeStart = base
        negativeStart.video.segment = .init(startMs: -10, endMs: base.video.segment.endMs - 10)
        #expect(negativeStart.validate().contains { $0.contains("non-negative") })

        var badRatio = base
        badRatio.quality.meanLimbConf = .nan
        #expect(badRatio.validate().contains { $0.contains("0...1") })

        #expect(PoseV1.isSkillId("bd.clear_fh") && PoseV1.isSkillId("pb.drop3"))
        #expect(!PoseV1.isSkillId("bd.") && !PoseV1.isSkillId("xx.clear") && !PoseV1.isSkillId("pb.Dink"))
    }

    @Test func timebaseRoundsNegativeValuesAwayFromZero() {
        #expect(Timebase.microseconds(value: -1, timescale: 3) == -333_333)
        #expect(Timebase.microseconds(value: -2, timescale: 3) == -666_667)
        #expect(Timebase.microseconds(value: Int64.max, timescale: 1) == nil) // beyond Int64 µs
        #expect(Timebase.microseconds(value: 9_000_000_000_000, timescale: 600) == 15_000_000_000_000_000)
        #expect(Timebase.milliseconds(fromMicroseconds: -1) == -1)
        #expect(Timebase.milliseconds(fromMicroseconds: -1_000) == -1)
    }

    @Test func schedulerResumeDropsOldFramesAndKeepsCadence() {
        var s = FrameScheduler(targetHz: 30, srcFps: 60)
        s.resume(afterUs: 1_000_000)
        // (#expect cannot call a mutating method directly.)
        let kept = [1_000_000, 1_016_667, 1_033_333, 1_050_000, 1_066_667].map { s.shouldKeep(ptsUs: $0) }
        #expect(kept == [false, false, true, false, true])
    }

    @Test func schedulerNeverExceedsTheTargetRateOnJitteredHighFpsSources() {
        // 120 fps with ±2 ms jitter decimated to 60 Hz: never two kept frames closer than period − half a source frame.
        var s = FrameScheduler(targetHz: 60, srcFps: 120)
        var kept: [Int64] = []
        for i in 0..<1_200 {
            let jitter = Int64((i * 7919) % 5) * 1_000 - 2_000
            let pts = Int64((Double(i) * 1_000_000 / 120).rounded()) + jitter
            if s.shouldKeep(ptsUs: pts) { kept.append(pts) }
        }
        let minSpacing = s.periodUs - s.halfSourceFrameUs
        #expect(zip(kept, kept.dropFirst()).allSatisfy { Double($0.1 - $0.0) >= minSpacing })
        #expect(kept.count >= 590 && kept.count <= 601, "kept \(kept.count)")
    }

    @Test func reacquireFallsBackToBoxHeightWithoutTorsoJoints() throws {
        let start = syntheticCandidate(cx: 0.3, cy: 0.5, height: 0.5)
        var tracker = Tracker(initial: start, tUs: 0, aspect: aspect)
        let lost = tracker.step(tUs: 600_000, candidates: [])
        #expect(lost.lost && lost.box == nil && lost.flags == .coasted)
        // No neck/root/shoulders/hips: torso is nil, so the box height decides eligibility.
        var legsAndArms = syntheticPerson(cx: 0.6, cy: 0.5, height: 0.5)
        for j in [Joint.neck, .root, .lSho, .rSho, .lHip, .rHip] { legsAndArms[j] = nil }
        let noTorso = try #require(CandidateBuilder.build(joints: legsAndArms, aspect: aspect))
        #expect(noTorso.torso == nil)
        let ratio = noTorso.bbox.h / start.bbox.h
        let step = tracker.step(tUs: 633_333, candidates: [noTorso])
        #expect(step.reacquired == (abs(ratio - 1) <= Tracker.reacquireTolerance))
    }

    @Test func gateIsStrictAndUsesTorsoUnits() {
        let start = syntheticCandidate(cx: 0.5, cy: 0.5, height: 0.5)
        var tracker = Tracker(initial: start, tUs: 0, aspect: aspect)
        // Far away (no overlap, > 1.5 torso): coasts instead of jumping to the other person.
        let far = syntheticCandidate(cx: 0.95, cy: 0.5, height: 0.5)
        let step = tracker.step(tUs: frameUs, candidates: [far])
        #expect(step.index == nil && step.coasted)
        #expect(tracker.state == .coasting)
    }

    @Test func liveFramingNeedsAllFourExtremities() {
        var joints = syntheticPerson(cx: 0.5, cy: 0.5, height: 0.45)
        joints[.lWri] = Keypoint(x: 0.4, y: 0.5, c: 0.29)
        let p = CandidateBuilder.build(joints: joints, aspect: aspect)
        let v = LiveFraming.evaluate(player: p, meanLuma: 0.5)
        #expect(!v.isGreen && v.hints == [.showFeet])
    }
}
