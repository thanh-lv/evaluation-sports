import Foundation
import Testing
@testable import CoachCore

@Suite("FrameScheduler")
struct FrameSchedulerTests {
    private func run(_ pts: [Int64], hz: Int, fps: Double) -> [Int64] {
        var s = FrameScheduler(targetHz: hz, srcFps: fps)
        return pts.filter { s.shouldKeep(ptsUs: $0) }
    }

    private func grid(fps: Double, from startUs: Int64 = 0, seconds: Double) -> [Int64] {
        let n = Int(seconds * fps)
        return (0..<n).map { startUs + Int64((Double($0) * 1_000_000 / fps).rounded()) }
    }

    @Test func sixtyToThirtyKeepsEveryOther() {
        let pts = grid(fps: 60, seconds: 2)
        let kept = run(pts, hz: 30, fps: 60)
        #expect(kept.count == 60)
        #expect(kept == stride(from: 0, to: pts.count, by: 2).map { pts[$0] })
    }

    @Test func ntscRatesKeepEveryFrameAtSameRate() {
        #expect(run(grid(fps: 59.94, seconds: 2), hz: 60, fps: 59.94).count == grid(fps: 59.94, seconds: 2).count)
        #expect(run(grid(fps: 29.97, seconds: 2), hz: 30, fps: 29.97).count == grid(fps: 29.97, seconds: 2).count)
    }

    @Test func jitteredThirtyKeepsAll() {
        let pts = grid(fps: 30, seconds: 3).enumerated().map { $0.element + Int64($0.offset % 3) * 2_000 }
        #expect(run(pts, hz: 30, fps: 30) == pts)
    }

    @Test func vfrGapCausesNoBurst() {
        // 60 fps for 1 s, a 0.5 s hole (VFR / dropped frames), then 60 fps again.
        let before = grid(fps: 60, seconds: 1)
        let after = grid(fps: 60, from: 1_500_000, seconds: 1)
        let kept = run(before + after, hz: 30, fps: 60)
        let s = FrameScheduler(targetHz: 30, srcFps: 60)
        let minSpacing = s.periodUs - s.halfSourceFrameUs
        for (a, b) in zip(kept, kept.dropFirst()) {
            #expect(Double(b - a) >= minSpacing, "burst between \(a) and \(b)")
        }
        // The first frame after the gap is kept, and the rate resumes at 30 Hz (no catch-up frames).
        #expect(kept.contains(1_500_000))
        let afterGap = kept.filter { $0 >= 1_500_000 && $0 < 1_700_000 }
        #expect(afterGap.count <= 7)
        #expect(afterGap.count >= 5)
    }

    @Test func naiveSchedulerWouldBurst() {
        // Documents the bug being prevented: `nextT += period` without max() keeps every frame after the gap.
        let pts = grid(fps: 60, seconds: 1) + grid(fps: 60, from: 1_500_000, seconds: 1)
        var next = 0.0
        var naive: [Int64] = []
        for p in pts where Double(p) >= next - 500_000 / 60 {
            naive.append(p)
            next += 1_000_000 / 30
        }
        let burst = zip(naive, naive.dropFirst()).contains { pair in pair.1 - pair.0 < 20_000 }
        #expect(burst)
        let kept = run(pts, hz: 30, fps: 60)
        #expect(!zip(kept, kept.dropFirst()).contains { pair in pair.1 - pair.0 < 20_000 })
    }

    @Test func dropsNonIncreasingPts() {
        #expect(run([0, 33_333, 33_333, 20_000, 66_667], hz: 30, fps: 30) == [0, 33_333, 66_667])
    }

    @Test func degenerateParametersFallBack() {
        var s = FrameScheduler(targetHz: 0, srcFps: .nan)
        #expect(s.targetHz == 30)
        let kept = s.shouldKeep(ptsUs: 0)
        #expect(kept)
    }

    @Test func timebaseConversion() {
        #expect(Timebase.microseconds(value: 1001, timescale: 30000) == 33_367)
        #expect(Timebase.microseconds(value: 600, timescale: 600) == 1_000_000)
        #expect(Timebase.microseconds(value: 1, timescale: 0) == nil)
        #expect(Timebase.microseconds(value: 1, timescale: 3) == 333_333)
        #expect(Timebase.microseconds(value: 2, timescale: 3) == 666_667)
        #expect(Timebase.milliseconds(fromMicroseconds: 13_910_583) == 13_910)
    }
}

@Suite("RateChooser")
struct RateChooserTests {
    @Test func lowFpsAlwaysThirty() {
        let r = RateChooser(srcFps: 30, segmentSec: 10)
        #expect(!r.needsBenchmark)
        #expect(r.isComplete)
        #expect(r.decide(thermal: .nominal) == 30)
    }

    @Test func warmupCallsAreDiscarded() {
        var r = RateChooser(srcFps: 60, segmentSec: 20)
        for _ in 0..<5 { r.recordVisionCall(milliseconds: 500) } // cold start
        #expect(r.msPerFrame == nil)
        for _ in 0..<19 { r.recordVisionCall(milliseconds: 10) }
        #expect(!r.isComplete)
        #expect(r.decide(thermal: .nominal) == 30)
        r.recordVisionCall(milliseconds: 10)
        r.recordVisionCall(milliseconds: 900) // beyond the timed window: ignored
        #expect(r.isComplete)
        #expect(r.msPerFrame == 10)
        // projected = 10 × 20 × 60 = 12 000 ≤ 1.5 × 20 000 + 10 000 = 40 000
        #expect(r.decide(thermal: .nominal) == 60)
        #expect(r.decide(thermal: .fair) == 60)
        #expect(r.decide(thermal: .serious) == 30)
    }

    @Test func budgetBoundary() {
        // budget for 10 s = 25 000 ms → msPerFrame limit = 25 000 / 600 ≈ 41.67
        #expect(RateChooser.choose(srcFps: 60, msPerFrame: 41, segmentSec: 10, thermal: .nominal) == 60)
        #expect(RateChooser.choose(srcFps: 60, msPerFrame: 42, segmentSec: 10, thermal: .nominal) == 30)
        #expect(RateChooser.choose(srcFps: 49.9, msPerFrame: 1, segmentSec: 10, thermal: .nominal) == 30)
    }

    @Test func sourceFpsVerdicts() {
        #expect(RateChooser.sourceFpsVerdict(60) == .ok)
        #expect(RateChooser.sourceFpsVerdict(30) == .ok)
        #expect(RateChooser.sourceFpsVerdict(29.97) == .warn)
        #expect(RateChooser.sourceFpsVerdict(24) == .warn)
        #expect(RateChooser.sourceFpsVerdict(23.976) == .reject)
        #expect(RateChooser.sourceFpsVerdict(.nan) == .reject)
    }
}
