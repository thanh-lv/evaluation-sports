import Foundation
import Testing
@testable import CoachCore

@Suite("Quality")
struct QualityTests {
    private func stats(total: Int = 100, withTarget: Int = 100, limb: Double = 0.8, height: Double = 0.5) -> QualityStats {
        QualityStats(
            framesTotal: total,
            framesWithTarget: withTarget,
            meanLimbConf: limb,
            playerHeightFracMedian: height,
            missingPct: total > 0 ? Double(total - withTarget) / Double(total) : 1,
            trackResets: 0,
            ambiguousAtMs: []
        )
    }

    @Test func passesGoodClip() {
        let v = QualityGate.evaluate(stats(), srcFps: 60, segmentMs: 10_000)
        #expect(v.passed)
        #expect(v.warnings.isEmpty)
    }

    @Test func thresholds() {
        #expect(QualityGate.evaluate(stats(withTarget: 59)).rejections == [.targetLost])
        #expect(QualityGate.evaluate(stats(withTarget: 60)).passed)
        #expect(QualityGate.evaluate(stats(height: 0.24)).rejections == [.playerTooSmall])
        let small = QualityGate.evaluate(stats(height: 0.30))
        #expect(small.passed && small.warnings == [.playerSmall])
        #expect(QualityGate.evaluate(stats(height: 0.35)).warnings.isEmpty)
        #expect(QualityGate.evaluate(stats(limb: 0.39)).rejections == [.lowVisibility])
        #expect(QualityGate.evaluate(stats(total: 1, withTarget: 1)).rejections == [.tooFewFrames])
        #expect(QualityGate.evaluate(stats(), srcFps: 23).rejections == [.fpsTooLow])
        #expect(QualityGate.evaluate(stats(), srcFps: 29.97).warnings == [.fpsLow])
        #expect(QualityGate.evaluate(stats(), segmentMs: 2_999).rejections == [.clipTooShort])
        #expect(QualityGate.evaluate(stats(), segmentMs: 32_001).rejections == [.clipTooLong])
    }

    @Test func tipsMatchServerCatalog() {
        #expect(QualityIssue.playerTooSmall.tips == [.moveCloser, .playerHeight])
        #expect(QualityIssue.targetLost.tips.map(\.rawValue) == ["camera.tip.one_player", "camera.tip.full_body"])
        let v = QualityVerdict(rejections: [.lowVisibility, .targetLost], warnings: [])
        #expect(v.tips == [.lighting, .fullBody, .steadyCamera, .onePlayer])
    }

    @Test func accumulator() {
        var acc = QualityAccumulator()
        let p = syntheticCandidate(cx: 0.5, cy: 0.5, height: 0.5)
        acc.add(tUs: 1_000_000, target: nil)
        acc.add(tUs: 1_033_333, target: p, ambiguous: true)
        acc.add(tUs: 1_066_667, target: p, ambiguous: true)
        acc.add(tUs: 1_100_000, target: p)
        acc.add(tUs: 1_133_333, target: p, reacquired: true, ambiguous: true)
        let s = acc.stats
        #expect(s.framesTotal == 5)
        #expect(s.framesWithTarget == 4)
        #expect(abs(s.meanLimbConf - 0.9) < 1e-9)
        #expect(abs(s.playerHeightFracMedian - p.bbox.h) < 1e-12)
        #expect(abs(s.missingPct - 0.2) < 1e-12)
        #expect(s.trackResets == 1)
        #expect(s.ambiguousAtMs == [1_033, 1_133])
    }

    @Test func median() {
        #expect(QualityAccumulator.median([]) == 0)
        #expect(QualityAccumulator.median([3, 1, 2]) == 2)
        #expect(QualityAccumulator.median([4, 1, 2, 3]) == 2.5)
    }

    @Test func liveFraming() {
        let good = syntheticCandidate(cx: 0.5, cy: 0.5, height: 0.5)
        #expect(LiveFraming.evaluate(player: good, meanLuma: 0.5).isGreen)
        let dark = LiveFraming.evaluate(player: good, meanLuma: 0.1)
        #expect(!dark.isGreen && dark.hints == [.backlight])
        let tooBig = LiveFraming.evaluate(player: syntheticCandidate(cx: 0.5, cy: 0.5, height: 0.75), meanLuma: 0.5)
        #expect(!tooBig.isGreen && tooBig.hints.contains(.stepBack))
        var noFeet = syntheticPerson(cx: 0.5, cy: 0.45, height: 0.5)
        noFeet[.lAnk] = nil
        noFeet[.rAnk] = nil
        let cut = CandidateBuilder.build(joints: noFeet, aspect: 16.0 / 9.0)
        let verdict = LiveFraming.evaluate(player: cut, meanLuma: 0.5)
        #expect(!verdict.isGreen && verdict.hints.contains(.showFeet))
        #expect(LiveFraming.evaluate(player: nil, meanLuma: 0.5).hints == [.noPlayer])
        #expect(LiveFraming.mostProminent([syntheticCandidate(cx: 0.2, cy: 0.5, height: 0.3), good]) == good)
    }
}
