import AVFoundation
import CoachCore
import Foundation

/// The PoseDump pipeline: composition reader → FrameScheduler → Vision (ROI from the tracker) → TargetSelector /
/// Tracker → QualityAccumulator / QualityGate → PoseV1Builder → JSON. Mirrors the app pipeline (DESIGN.md §5.4).
enum PoseDumpCommand {
    static func main(arguments: [String]) async -> Int32 {
        let options: Options
        do {
            options = try Options.parse(arguments)
        } catch {
            log("\(error)")
            return 1
        }
        do {
            return try await run(options)
        } catch let e as SelectionAmbiguous {
            log(e.description)
            return 2
        } catch {
            log("error: \(error)")
            return 1
        }
    }

    struct SelectionAmbiguous: Error, CustomStringConvertible {
        let description: String
    }

    static func run(_ o: Options) async throws -> Int32 {
        let asset = AVURLAsset(url: o.input)
        let info = try await AssetInfo.load(asset)
        let display = info.renderSize
        let aspect = display.aspect
        let durationMs = info.durationMs

        // Segment (exported-clip timeline).
        let startMs = Int64(((o.startSec ?? 0) * 1000).rounded())
        let endMs = o.endSec.map { Int64(($0 * 1000).rounded()) } ?? durationMs
        let segmentMs = endMs - startMs
        guard segmentMs > 0, endMs <= durationMs + 50 else {
            throw OptionsError("segment \(startMs)..\(endMs) ms is outside the clip (0..\(durationMs) ms)")
        }
        guard segmentMs >= QualityGate.minSegmentMs, segmentMs <= QualityGate.maxSegmentMs else {
            throw OptionsError("segment is \(segmentMs) ms; pose.v1 needs 3..32 s (use --start/--end)")
        }

        let fpsVerdict = RateChooser.sourceFpsVerdict(info.nominalFps)
        let hz = o.hz ?? (info.nominalFps >= RateChooser.highRateMinSourceFps ? 60 : 30)
        log(String(format: "%@: %ldx%ld display (render %ldx%ld), %.3f fps (%@), %@, analysing %lld..%lld ms at %ld Hz",
                   o.input.lastPathComponent, info.displaySize.w, info.displaySize.h, display.w, display.h,
                   info.nominalFps, fpsVerdict.rawValue, info.mirrored ? "mirrored" : "not mirrored", startMs, endMs, hz))

        let reader = try CompositionFrameReader(asset: asset, info: info, startMs: startMs, endMs: endMs)
        let estimator = VisionPoseEstimator(roiRelative: o.roiRelative)
        var scheduler = FrameScheduler(targetHz: hz, srcFps: info.nominalFps)
        var quality = QualityAccumulator()
        let analysisUUID = try requireUUID(o.analysisId)
        var builder = PoseV1Builder(
            analysisId: analysisUUID,
            client: PoseV1.Client(app: "posedump", build: "1", os: osVersion(), device: hardwareModel()),
            session: PoseV1.Session(
                sport: o.sport, skill: o.skill, handedness: o.handedness, level: o.level, cameraView: o.view,
                subject: .oneself, subjectConsent: false, subjectMinor: false, language: o.language
            ),
            video: PoseV1.Video(
                source: o.source, durationMs: durationMs, segment: .init(startMs: startMs, endMs: endMs),
                srcFps: (info.nominalFps * 1000).rounded() / 1000, analysisHz: hz,
                display: .init(display), mirrored: info.mirrored
            )
        )

        let segmentStartUs = startMs * 1000
        var tracker: Tracker?
        var decoded = 0
        var visionMs = 0.0
        var visionCalls = 0
        var selectionError: Error?

        func detect(_ buffer: CVPixelBuffer, roi: Rect) throws -> [PersonCandidate] {
            let t0 = DispatchTime.now().uptimeNanoseconds
            defer {
                visionMs += Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000
                visionCalls += 1
            }
            return try estimator.detect(pixelBuffer: buffer, cfsRoi: roi, aspect: aspect)
        }

        try reader.forEachFrame { tUs, buffer in
            decoded += 1
            guard scheduler.shouldKeep(ptsUs: tUs) else { return true }

            guard var current = tracker else {
                // Selection phase: first frame with people inside [segment start, +3 s].
                guard TargetSelector.isInSelectionWindow(tUs: tUs, segmentStartUs: segmentStartUs) else {
                    selectionError = OptionsError("no player detected in the first 3 s of the segment")
                    return false
                }
                let candidates = try detect(buffer, roi: .unit)
                guard !candidates.isEmpty else {
                    builder.appendMissing(tUs: tUs)
                    quality.add(tUs: tUs, target: nil)
                    return true
                }
                let chosen: Int?
                switch o.select {
                case .auto: chosen = TargetSelector.autoSelect(candidates: candidates)
                case .tap(let p): chosen = TargetSelector.select(tap: p, candidates: candidates, aspect: aspect)
                }
                guard let index = chosen else {
                    selectionError = SelectionAmbiguous(description: describe(candidates, at: tUs, mode: o.select))
                    return false
                }
                let target = candidates[index]
                tracker = Tracker(initial: target, tUs: tUs, aspect: aspect)
                builder.append(tUs: tUs, target: target, box: target.bbox, flags: [])
                quality.add(tUs: tUs, target: target)
                if o.verbose { log("\(tUs) selected candidate \(index) box \(fmt(target.bbox))") }
                return true
            }

            // Tracking phase. Pose runs on the ROI; if nothing passes the gate there, retry once on the full frame.
            let roi = o.useRoi ? current.roi : .unit
            var candidates = try detect(buffer, roi: roi)
            var trial = current
            var step = trial.step(tUs: tUs, candidates: candidates)
            if step.index == nil, roi != .unit {
                candidates = try detect(buffer, roi: .unit)
                trial = current
                step = trial.step(tUs: tUs, candidates: candidates)
            }
            current = trial
            tracker = current
            builder.append(tUs: tUs, step: step, candidates: candidates)
            quality.add(tUs: tUs, step: step, candidates: candidates)
            if o.verbose {
                let state = step.index != nil ? (step.reacquired ? "reacquired" : "tracked") : (step.lost ? "lost" : "coasted")
                log("\(tUs) \(state)\(step.ambiguous ? " ambiguous" : "") candidates=\(candidates.count) roi=\(fmt(roi))")
            }
            return true
        }
        if let e = selectionError {
            reader.cancel()
            throw e
        }
        guard tracker != nil else { throw OptionsError("no player detected in the first 3 s of the segment") }

        let stats = quality.stats
        let verdict = QualityGate.evaluate(stats, srcFps: info.nominalFps, segmentMs: segmentMs)
        let pose = try builder.build(quality: stats)
        let issues = pose.validate()
        for issue in issues { log("pose.v1 check: \(issue)") }

        let encoder = PoseV1.makeEncoder(pretty: o.pretty)
        let data = try encoder.encode(pose)
        try data.write(to: o.output, options: .atomic)

        log(String(format: "decoded %ld frames, kept %ld at %ld Hz, target in %.1f%%, median height %.2f, limb conf %.2f, resets %ld, ambiguous runs %ld, vision %.1f ms/frame",
                   decoded, stats.framesTotal, hz, stats.presence * 100, stats.playerHeightFracMedian, stats.meanLimbConf,
                   stats.trackResets, stats.ambiguousAtMs.count, visionCalls > 0 ? visionMs / Double(visionCalls) : 0))
        if data.count > PoseV1.maxBytes { log("warning: \(data.count) bytes exceeds the 1.2 MB prepare limit") }
        if !verdict.warnings.isEmpty { log("quality warnings: \(verdict.warnings.map(\.rawValue).joined(separator: ", "))") }
        log("wrote \(o.output.path) (\(data.count) bytes)")
        if !verdict.passed {
            log("QUALITY GATE REJECT: \(verdict.rejections.map(\.rawValue).joined(separator: ", ")) (file written anyway)")
            return 3
        }
        return issues.isEmpty ? 0 : 1
    }

    // MARK: - Helpers

    private static func requireUUID(_ s: String) throws -> UUID {
        guard let id = UUID(uuidString: s) else { throw OptionsError("invalid analysis id \(s)") }
        return id
    }

    private static func describe(_ candidates: [PersonCandidate], at tUs: Int64, mode: SelectMode) -> String {
        var lines = [String]()
        switch mode {
        case .auto:
            lines.append("ambiguous: \(candidates.count) people at t=\(tUs) µs and none is dominant; rerun with --select x,y (normalized, top-left):")
        case .tap(let p):
            lines.append("no person box contains the tap \(p.x),\(p.y) at t=\(tUs) µs; people found:")
        }
        for (i, c) in candidates.enumerated() {
            lines.append(String(format: "  #%ld centre %.3f,%.3f  box %@  mean conf %.2f", i, c.bbox.center.x, c.bbox.center.y, fmt(c.bbox), c.meanConfidence))
        }
        return lines.joined(separator: "\n")
    }

    private static func fmt(_ r: Rect) -> String {
        String(format: "[%.3f %.3f %.3f %.3f]", r.x, r.y, r.w, r.h)
    }

    private static func osVersion() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    private static func hardwareModel() -> String {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else { return "mac" }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &buffer, &size, nil, 0) == 0 else { return "mac" }
        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return String(decoding: bytes, as: UTF8.self)
    }

    static func log(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
