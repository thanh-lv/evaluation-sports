import Foundation
import Testing
@testable import CoachCore

@Suite("Quantizer")
struct QuantizerTests {
    @Test func integerRoundTripIsExact() {
        for x in stride(from: 0, through: 1000, by: 1) {
            let k = Quantizer.dequantize(x: x, y: 1000 - x, c: 30 + x % 71)
            #expect(Quantizer.keypoint(k) == [x, 1000 - x, 30 + x % 71])
        }
    }

    @Test func doubleRoundTripWithinHalfStep() {
        for i in 0...997 {
            let v = Double(i) / 997.0
            let q = Quantizer.coordinate(v)
            #expect(abs(Double(q) / 1000 - v) <= 0.0005 + 1e-12)
        }
    }

    @Test func missingAndLowConfidence() {
        #expect(Quantizer.keypoint(nil) == [0, 0, 0])
        #expect(Quantizer.keypoint(Keypoint(x: 0.5, y: 0.5, c: 0.29)) == [0, 0, 0])
        #expect(Quantizer.keypoint(Keypoint(x: 0.5, y: 0.5, c: 0.3)) == [500, 500, 30])
        #expect(Quantizer.keypoint(Keypoint(x: .nan, y: 0.5, c: 0.9)) == [0, 0, 0])
        #expect(Quantizer.keypoint(Keypoint(x: -0.2, y: 1.7, c: 1.4)) == [0, 1000, 100])
        #expect(Quantizer.dequantize(x: 0, y: 0, c: 0) == nil)
        #expect(Quantizer.coordinate(.infinity) == 0)
    }

    @Test func roundsHalfAwayFromZeroLikeJS() {
        #expect(Quantizer.coordinate(0.0005) == 1)
        #expect(Quantizer.coordinate(0.0015) == 2)
        #expect(Quantizer.confidence(0.875) == 88)
    }

    @Test func frameRowAndBox() {
        let row = Quantizer.frame([.nose: Keypoint(x: 0.512, y: 0.233, c: 0.91), .rAnk: Keypoint(x: 0.1, y: 0.9, c: 0.1)])
        #expect(row.count == 57)
        #expect(Array(row[0..<3]) == [512, 233, 91])
        #expect(Array(row[54..<57]) == [0, 0, 0])
        #expect(Quantizer.frame(nil) == Array(repeating: 0, count: 57))
        #expect(Quantizer.box(Rect(x: 0.43, y: 0.18, w: 0.17, h: 0.56)) == [430, 180, 170, 560])
        #expect(Quantizer.box(Rect(x: -0.1, y: 0.5, w: 0.3, h: 0.7)) == [0, 500, 200, 500])
        let joints = Quantizer.joints(fromRow: row)
        #expect(joints.count == 1)
        #expect(joints[.nose] == Keypoint(x: 0.512, y: 0.233, c: 0.91))
    }
}

@Suite("PoseV1Builder")
struct PoseV1BuilderTests {
    static let client = PoseV1.Client(app: "1.0.0", build: "1", os: "iOS 18.6", device: "iPhone16,1")
    static let session = PoseV1.Session(
        sport: .badminton, skill: "bd.clear_fh", handedness: .right, level: nil, cameraView: .auto,
        subject: .oneself, subjectConsent: false, subjectMinor: false, language: .vi
    )
    static let video = PoseV1.Video(
        source: .recorded, durationMs: 12_000, segment: .init(startMs: 1_000, endMs: 11_000), srcFps: 59.94,
        analysisHz: 60, display: .init(w: 1920, h: 1080), mirrored: false
    )

    @Test func buildsValidDocumentWithBackfilledBoxes() throws {
        var b = try PoseV1Builder(analysisId: "0B0C4F1E-5A8D-4C47-9B1E-6C1F2A3B4C5D", client: Self.client, session: Self.session, video: Self.video)
        var acc = QualityAccumulator()
        let p = syntheticCandidate(cx: 0.5, cy: 0.5, height: 0.5)
        var tracker: Tracker?
        for i in 0..<120 {
            let t = 1_000_000 + Int64(i) * 16_683
            if i < 3 {
                let kept = b.appendMissing(tUs: t) // before selection
                #expect(kept)
                acc.add(tUs: t, target: nil)
                continue
            }
            if tracker == nil {
                tracker = Tracker(initial: p, tUs: t, aspect: 16.0 / 9.0)
                let kept = b.append(tUs: t, target: p, box: p.bbox, flags: [])
                #expect(kept)
                acc.add(tUs: t, target: p)
                continue
            }
            let cands = (50..<60).contains(i) ? [] : [p]
            guard var tr = tracker else { continue }
            let step = tr.step(tUs: t, candidates: cands)
            tracker = tr
            let kept = b.append(tUs: t, step: step, candidates: cands)
            #expect(kept)
            acc.add(tUs: t, step: step, candidates: cands)
        }
        let late = b.append(tUs: 1_000_000, target: p, box: p.bbox, flags: []) // not increasing → dropped
        #expect(!late)
        let pose = try b.build(quality: acc.stats)
        #expect(pose.validate().isEmpty, "\(pose.validate())")
        #expect(pose.analysisId == "0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d")
        #expect(pose.track.count == 120)
        // Frames before selection: missing joints, coasted, box back-filled from the first known box.
        #expect(pose.track.kp[0] == Array(repeating: 0, count: 57))
        #expect(pose.track.flags[0] == TrackFlags.coasted.rawValue)
        #expect(pose.track.bbox[0] == Quantizer.box(p.bbox))
        #expect(pose.track.flags[3] == 0)
        #expect(pose.track.flags[55] == TrackFlags.coasted.rawValue)
        #expect(pose.quality.framesTotal == 120)
        #expect(pose.quality.framesWithTarget == 107)
        // `level: nil` is omitted (client → server optional).
        let json = try #require(String(data: try pose.encodedForUpload(), encoding: .utf8))
        #expect(!json.contains("\"level\""))
        #expect(json.contains("\"tUs\":[1000000,1016683"))
        #expect(try JSONDecoder().decode(PoseV1.self, from: try pose.encodedForUpload()) == pose)
    }

    @Test func rejectsDegenerateInput() throws {
        #expect(throws: PoseBuildError.invalidAnalysisId("nope")) {
            _ = try PoseV1Builder(analysisId: "nope", client: Self.client, session: Self.session, video: Self.video)
        }
        var b = PoseV1Builder(analysisId: UUID(), client: Self.client, session: Self.session, video: Self.video)
        b.appendMissing(tUs: 0)
        #expect(throws: PoseBuildError.tooFewFrames(count: 1)) { _ = try b.build(quality: QualityAccumulator().stats) }
        b.appendMissing(tUs: 1)
        #expect(throws: PoseBuildError.noTargetBox) { _ = try b.build(quality: QualityAccumulator().stats) }
    }

    @Test func validateCatchesServerRules() throws {
        let data = try Fixtures.data("pose/synthetic_minimal.json")
        var pose = try JSONDecoder().decode(PoseV1.self, from: data)
        #expect(pose.validate().isEmpty)
        pose.session.skill = "pb.dink"
        pose.track.tUs[5] = pose.track.tUs[4]
        pose.analysisId = pose.analysisId.uppercased()
        let issues = pose.validate()
        #expect(issues.count == 3, "\(issues)")
    }
}

@Suite("Fixtures round-trip (decoded values)")
struct FixtureRoundTripTests {
    static let poseFixtures = Fixtures.jsonFiles(in: "pose")

    @Test func poseFixturesExist() {
        #expect(Self.poseFixtures.count >= 1)
    }

    @Test(arguments: FixtureRoundTripTests.poseFixtures)
    func poseFixture(url: URL) throws {
        let data = try Data(contentsOf: url)
        let r = try roundTrip(PoseV1.self, data)
        #expect(r.original == r.again)
        #expect(r.fixturePaths == r.encodedPaths)
        #expect(r.original.validate().isEmpty, "\(url.lastPathComponent): \(r.original.validate())")
        // Timeline and joints decode sensibly.
        let timeline = PoseTimeline(pose: r.original)
        #expect(timeline.tUs.count == r.original.track.count)
    }

    @Test func prepareFixture() throws {
        let r = try roundTrip(PrepareResponseV1.self, try Fixtures.data("prepare/example.json"))
        #expect(r.original == r.again)
        #expect(r.fixturePaths == r.encodedPaths)
        let p = r.original
        #expect(p.schema == PrepareResponseV1.schemaId)
        #expect(p.handednessSuggestion == nil)
        #expect(p.warnings == [.viewLowConfidence])
        #expect(p.strokes.count == 4)
        #expect(p.strokes[1].role == .best && p.strokes[3].excluded)
        #expect(p.strokes[0].tContactUs == 3_910_583)
        #expect(p.frameRequests.count == 9)
        #expect(p.uploadRequests.map(\.frameId) == [.F1, .F2, .F3, .F4, .F5])
        #expect(p.frameRequests[4].phase == .overview)
        #expect(p.frameRequests[0].crop == Rect(x: 0.38, y: 0.09, w: 0.33, h: 0.62))
        #expect(p.quota.resetsAt == "2026-11-01T00:00:00+07:00")
    }

    @Test(arguments: ["results/example_full.json", "results/example_free.json"])
    func resultFixture(path: String) throws {
        let r = try roundTrip(CoachResultV1.self, try Fixtures.data(path))
        #expect(r.original == r.again)
        #expect(r.fixturePaths == r.encodedPaths)
        let res = r.original
        #expect(res.schema == CoachResultV1.schemaId)
        #expect(res.subScores.map(\.key) == SubScoreKey.allCases)
        #expect(res.hero?.drill?.dose.reps == 10)
        #expect(res.hero?.drill?.dose.seconds == nil)
        if res.access == .free {
            #expect(res.checkpoints == nil)
            #expect(res.strengths.count <= 1)
            #expect(res.weaknesses.isEmpty && res.plan.isEmpty)
            #expect(res.locked.total > 0)
        } else {
            #expect(res.checkpoints?.isEmpty == false)
            #expect(res.locked.total == 0)
            #expect(res.plan.map(\.priority) == Array(1...res.plan.count))
        }
        for s in res.subScores {
            if let score = s.displayScore { #expect(score % 5 == 0) }
        }
    }

    @Test func fullResultDetails() throws {
        let res = try JSONDecoder().decode(CoachResultV1.self, from: try Fixtures.data("results/example_full.json"))
        let ev = try #require(res.strengths.first?.evidence.first)
        #expect(ev.tUs == 7_883_333 && ev.frameId == .F3 && ev.joints == [.rSho, .rWri])
        let visual = try #require(res.strengths.dropFirst().first?.evidence.first)
        #expect(visual.metricKey == nil && visual.detail == nil)
        let cp = try #require(res.checkpoints?.first { $0.assess == .mApprox })
        #expect(cp.perStroke.first?.value == 41)
        #expect(res.stroke(role: .worst)?.id == 3)
        #expect(res.safety.first?.kind == .warmup)
    }

    @Test func cleanTrackFixtures() throws {
        // Any committed clean-track fixture (none may exist yet) plus an inline sample.
        for url in Fixtures.files(withSchema: CleanTrackV1.schemaId) {
            let r = try roundTrip(CleanTrackV1.self, try Data(contentsOf: url))
            #expect(r.original == r.again, "\(url.lastPathComponent)")
            #expect(r.fixturePaths == r.encodedPaths, "\(url.lastPathComponent)")
        }
        let inline = """
        {"schema":"clean-track.v1","analysisId":"0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d","algoVersion":"engine-0.1.0",
         "analysisHz":30,"display":{"w":1920,"h":1080},"mirrored":false,"torsoT":0.18,
         "jointOrder":["nose","lEye","rEye","lEar","rEar","neck","lSho","rSho","lElb","rElb","lWri","rWri","root","lHip","rHip","lKne","rKne","lAnk","rAnk"],
         "t0Us":1000000,"tUs":[1000000,1033333],
         "kp":[[500.5,270.1,95,0,0,0,0,0,0,0,0,0,0,0,0,500,330,90,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,500,500,88,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
               [501,271,95,0,0,0,0,0,0,0,0,0,0,0,0,501,331,90,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,501,501,88,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]],
         "interp":[0,4096],
         "strokes":[{"id":1,"tStartUs":1000000,"tContactUs":1033333,"contactIsEstimate":true,"tEndUs":1033333,
                     "phases":{"swingStart":null,"ready":1000000,"bsEnd":1000000,"contact":1033333,"ftStop":1033333,"recovery":null},
                     "role":"best","excluded":false}]}
        """
        let r = try roundTrip(CleanTrackV1.self, Data(inline.utf8))
        #expect(r.original == r.again)
        #expect(r.fixturePaths == r.encodedPaths)
        let track = r.original
        #expect(track.isInterpolated(frame: 1, joint: .root))
        #expect(!track.isInterpolated(frame: 0, joint: .root))
        #expect(track.strokes[0].phases.swingStart == nil)
        let nose = try #require(track.joints(at: 0)[.nose])
        #expect(abs(nose.x - 0.5005) < 1e-12 && abs(nose.y - 0.2701) < 1e-12 && abs(nose.c - 0.95) < 1e-12)
        #expect(track.joints(at: 0).count == 3)
    }

    @Test func requestBodiesEncodeExpectedKeys() throws {
        let reprepare = ReprepareV1(analysisId: "0B0C4F1E-5A8D-4C47-9B1E-6C1F2A3B4C5D", cameraView: .diagonal, excludedStrokeIds: [3, 1], handedness: .right)
        let obj = try #require(JSONSerialization.jsonObject(with: try JSONEncoder().encode(reprepare)) as? [String: Any])
        #expect(Set(obj.keys) == ["schema", "analysisId", "cameraView", "excludedStrokeIds", "handedness"])
        #expect(obj["schema"] as? String == "reprepare.v1")
        #expect(obj["analysisId"] as? String == "0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d")
        #expect(obj["excludedStrokeIds"] as? [Int] == [1, 3])

        let submit = try JSONEncoder().encode(SubmitRequest(analysisId: UUID()))
        let submitObj = try #require(JSONSerialization.jsonObject(with: submit) as? [String: Any])
        #expect(Set(submitObj.keys) == ["analysisId"]) // nil token omitted
        let del = try #require(JSONSerialization.jsonObject(with: try JSONEncoder().encode(DeleteAccountRequest())) as? [String: Any])
        #expect(del["confirm"] as? Bool == true)
    }

    @Test func serverBodiesDecodeNullOrMissing() throws {
        let quota = #"{"code":"quota_exceeded","limit":3,"used":3,"resetsAt":null}"#
        let e = try JSONDecoder().decode(ApiError.self, from: Data(quota.utf8))
        #expect(e.knownCode == .quotaExceeded && e.knownCode?.httpStatus == 402 && e.resetsAt == nil && e.tips == nil)
        let rej = try JSONDecoder().decode(ApiError.self, from: Data(#"{"code":"player_too_small","tips":["camera.tip.move_closer","x.unknown"]}"#.utf8))
        #expect(rej.knownCode?.isPrepareRejection == true && rej.tipKeys == [.moveCloser])
        let unknown = try JSONDecoder().decode(ApiError.self, from: Data(#"{"code":"brand_new"}"#.utf8))
        #expect(unknown.knownCode == nil)

        let sub = #"{"tier":"premium","productId":null,"expiresAt":"2026-11-18T00:00:00Z","willRenew":true,"inGrace":false,"billingIssue":false,"isTrial":false,"transferred":false}"#
        let v = try JSONDecoder().decode(VerifySubscriptionResponse.self, from: Data(sub.utf8))
        #expect(v.tier == .premium && v.productId == nil)

        let catalog = #"{"schema":"catalog.v1","skills":[{"id":"bd.clear_fh","sport":"badminton","name":{"vi":"Phông cầu","en":"Clear"},"views":{"recommended":["S"],"allowed":["S","B","D"]},"viewCoverage":{"S":1,"B":0.6},"solo":false}],"plans":[{"tier":"free","periodType":"calendar_month","totalLimit":2,"standardLimit":1}]}"#
        let c = try JSONDecoder().decode(CatalogResponseV1.self, from: Data(catalog.utf8))
        #expect(c.skills[0].coverage(for: .B) == 0.6 && c.skills[0].coverage(for: .D) == nil)
        #expect(c.plans[0].periodType == .calendarMonth)
        let submitResp = try JSONDecoder().decode(SubmitResponse.self, from: Data(#"{"status":"queued","pollAfterMs":2000}"#.utf8))
        #expect(submitResp.status == .queued)
    }

    @Test func subjectSelfWireValue() throws {
        let data = try JSONEncoder().encode(Subject.oneself)
        #expect(String(data: data, encoding: .utf8) == "\"self\"")
    }
}
