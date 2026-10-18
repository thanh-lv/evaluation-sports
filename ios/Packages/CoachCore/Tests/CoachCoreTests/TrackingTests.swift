import Foundation
import Testing
@testable import CoachCore

private let aspect = 16.0 / 9.0
private let frameUs: Int64 = 33_333

@Suite("CandidateBuilder and TargetSelector")
struct SelectionTests {
    @Test func buildsPaddedBoxWithHeadroom() throws {
        let joints = syntheticPerson(cx: 0.5, cy: 0.5, height: 0.5)
        let c = try #require(CandidateBuilder.build(joints: joints, aspect: aspect))
        let torso = try #require(c.torso)
        #expect(abs(torso - 0.175) < 1e-9)
        // Raw joint extent is y ∈ [0.28, 0.71]; the box adds 5 % padding per side plus 0.5 torso above.
        #expect(c.bbox.minY < 0.28 - 0.08)
        #expect(c.bbox.maxY > 0.71)
        #expect(abs(c.meanConfidence - 0.9) < 1e-9)
    }

    @Test func ignoresLowConfidenceAndNonFiniteJoints() {
        var joints = syntheticPerson(cx: 0.5, cy: 0.5, height: 0.5, conf: 0.2)
        #expect(CandidateBuilder.build(joints: joints, aspect: aspect) == nil)
        joints[.nose] = Keypoint(x: .nan, y: 0.5, c: 0.9)
        joints[.neck] = Keypoint(x: 0.5, y: .infinity, c: 0.9)
        #expect(CandidateBuilder.build(joints: joints, aspect: aspect) == nil)
    }

    @Test func autoSelectRule() {
        let main = syntheticCandidate(cx: 0.5, cy: 0.5, height: 0.6)
        let small = syntheticCandidate(cx: 0.85, cy: 0.3, height: 0.2) // area ≈ 11 % of main
        let similar = syntheticCandidate(cx: 0.2, cy: 0.5, height: 0.5)
        let faint = syntheticCandidate(cx: 0.2, cy: 0.5, height: 0.5, conf: 0.3)
        #expect(TargetSelector.autoSelect(candidates: [main]) == 0)
        // A small (area < 30 %) bystander, even a confident one, does not block auto-selection.
        #expect(TargetSelector.autoSelect(candidates: [small, main]) == 1)
        #expect(TargetSelector.autoSelect(candidates: [small]) == 0)
        // A second confident person → tap screen.
        #expect(TargetSelector.autoSelect(candidates: [main, similar]) == nil)
        // A faint but big second person (area ≥ 30 %) → tap screen.
        #expect(TargetSelector.autoSelect(candidates: [main, faint]) == nil)
        #expect(TargetSelector.autoSelect(candidates: []) == nil)
    }

    @Test func tapSelection() {
        let left = syntheticCandidate(cx: 0.3, cy: 0.5, height: 0.6)
        let right = syntheticCandidate(cx: 0.4, cy: 0.5, height: 0.6) // overlaps `left`
        #expect(TargetSelector.select(tap: Point(x: 0.28, y: 0.5), candidates: [left, right], aspect: aspect) == 0)
        #expect(TargetSelector.select(tap: Point(x: 0.39, y: 0.5), candidates: [left, right], aspect: aspect) == 1)
        #expect(TargetSelector.select(tap: Point(x: 0.95, y: 0.05), candidates: [left, right], aspect: aspect) == nil)
        #expect(TargetSelector.isInSelectionWindow(tUs: 4_000_000, segmentStartUs: 1_000_000))
        #expect(!TargetSelector.isInSelectionWindow(tUs: 4_000_001, segmentStartUs: 1_000_000))
    }
}

@Suite("Tracker")
struct TrackerTests {
    /// Two players cross horizontally; the candidate order alternates so index bias cannot help.
    private func crossing(heightB: Double, cyB: Double) -> (hits: Int, frames: Int) {
        let n = 31
        func a(_ i: Int) -> PersonCandidate { syntheticCandidate(cx: 0.2 + 0.02 * Double(i), cy: 0.5, height: 0.5) }
        func b(_ i: Int) -> PersonCandidate { syntheticCandidate(cx: 0.8 - 0.02 * Double(i), cy: cyB, height: heightB) }
        var tracker = Tracker(initial: a(0), tUs: 0, aspect: aspect)
        var hits = 0
        for i in 1..<n {
            let ca = a(i)
            let cands = i % 2 == 0 ? [ca, b(i)] : [b(i), ca]
            let step = tracker.step(tUs: Int64(i) * frameUs, candidates: cands)
            if let idx = step.index, cands[idx] == ca { hits += 1 }
        }
        return (hits, n - 1)
    }

    @Test func staysOnTargetThroughCrossing() {
        let differentSize = crossing(heightB: 0.45, cyB: 0.5)
        #expect(differentSize.hits == differentSize.frames)
        let sameSizeOffset = crossing(heightB: 0.5, cyB: 0.53)
        #expect(sameSizeOffset.hits == sameSizeOffset.frames)
    }

    @Test func flagsAmbiguity() {
        let start = syntheticCandidate(cx: 0.5, cy: 0.5, height: 0.5)
        var tracker = Tracker(initial: start, tUs: 0, aspect: aspect)
        let left = syntheticCandidate(cx: 0.48, cy: 0.5, height: 0.5)
        let right = syntheticCandidate(cx: 0.52, cy: 0.5, height: 0.5)
        let step = tracker.step(tUs: frameUs, candidates: [left, right])
        #expect(step.index != nil)
        #expect(step.ambiguous)
        let clear = tracker.step(tUs: 2 * frameUs, candidates: [syntheticCandidate(cx: 0.48, cy: 0.5, height: 0.5)])
        #expect(!clear.ambiguous)
    }

    @Test func roiFollowsTargetAndResetsWhileCoasting() {
        let small = syntheticCandidate(cx: 0.5, cy: 0.6, height: 0.15)
        var tracker = Tracker(initial: small, tUs: 0, aspect: aspect)
        #expect(tracker.roi.h >= Tracker.roiMinHeight - 1e-12)
        #expect(tracker.roi.contains(small.bbox.center))
        let step = tracker.step(tUs: frameUs, candidates: [small])
        #expect(step.roi.minX >= 0 && step.roi.minY >= 0 && step.roi.maxX <= 1 + 1e-12 && step.roi.maxY <= 1 + 1e-12)
        #expect(step.roi.h >= 0.4 - 1e-12)
        #expect(step.roi.intersection(small.bbox)?.area ?? 0 >= small.bbox.area * 0.999)

        let coast = tracker.step(tUs: 2 * frameUs, candidates: [])
        #expect(coast.coasted && coast.index == nil && !coast.lost)
        #expect(coast.roi == .unit)
        #expect(coast.flags == .coasted)

        let edge = syntheticCandidate(cx: 0.04, cy: 0.5, height: 0.5)
        let roi = Tracker.roi(around: edge.bbox)
        #expect(roi.minX >= 0 && roi.maxX <= 1 + 1e-12)
        let tall = Tracker.roi(around: syntheticCandidate(cx: 0.5, cy: 0.5, height: 0.8).bbox)
        #expect(tall.minY == 0 && tall.h == 1)
    }

    @Test func shortGapCoastsThenMatchesWithoutReacquire() {
        func a(_ i: Int) -> PersonCandidate { syntheticCandidate(cx: 0.3 + 0.01 * Double(i), cy: 0.5, height: 0.5) }
        var tracker = Tracker(initial: a(0), tUs: 0, aspect: aspect)
        var coasted = 0
        for i in 1...20 {
            let present = !(10...18).contains(i) // 9 frames ≈ 0.3 s missing
            let step = tracker.step(tUs: Int64(i) * frameUs, candidates: present ? [a(i)] : [])
            if present {
                #expect(step.index == 0)
                #expect(!step.reacquired)
            } else {
                coasted += 1
                #expect(step.coasted && !step.lost)
                // Constant-velocity prediction keeps moving right.
                #expect((step.box?.center.x ?? 0) > a(9).bbox.center.x)
            }
        }
        #expect(coasted == 9)
        #expect(tracker.resets == 0)
    }

    @Test func longGapLosesThenReacquiresSimilarSizeOnly() {
        let a0 = syntheticCandidate(cx: 0.3, cy: 0.5, height: 0.5)
        let child = syntheticCandidate(cx: 0.85, cy: 0.6, height: 0.25) // far away, half the torso: never re-acquired
        var tracker = Tracker(initial: a0, tUs: 0, aspect: aspect)
        var sawLost = false
        for i in 1...30 {
            let step = tracker.step(tUs: Int64(i) * frameUs, candidates: [child])
            #expect(step.index == nil)
            if step.lost { sawLost = true }
        }
        #expect(sawLost)
        #expect(tracker.state == .lost)
        let back = syntheticCandidate(cx: 0.6, cy: 0.5, height: 0.52)
        let step = tracker.step(tUs: 31 * frameUs, candidates: [child, back])
        #expect(step.index == 1)
        #expect(step.reacquired)
        #expect(step.flags == .reacquired)
        #expect(tracker.resets == 1)
        #expect(tracker.state == .tracking)
    }

    @Test func trackerIsCodable() throws {
        var tracker = Tracker(initial: syntheticCandidate(cx: 0.5, cy: 0.5, height: 0.5), tUs: 0, aspect: aspect)
        _ = tracker.step(tUs: frameUs, candidates: [syntheticCandidate(cx: 0.51, cy: 0.5, height: 0.5)])
        let data = try JSONEncoder().encode(tracker)
        #expect(try JSONDecoder().decode(Tracker.self, from: data) == tracker)
    }
}
