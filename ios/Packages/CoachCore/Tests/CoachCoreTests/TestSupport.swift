import Foundation
@testable import CoachCore

// On Apple platforms MacTypes.h also declares `Point` and `Rect`; module-level aliases make the CoachCore types win
// unambiguously inside this test module.
typealias Point = CoachCore.Point
typealias Rect = CoachCore.Rect

/// Repo-relative fixture access. Fixtures are read in place from `shared/fixtures/**` (never copied).
enum Fixtures {
    /// `<repo>/ios/Packages/CoachCore/Tests/CoachCoreTests/TestSupport.swift` → `<repo>`.
    static let repoRoot: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url = url.deletingLastPathComponent() }
        return url
    }()

    static let root = repoRoot.appendingPathComponent("shared/fixtures", isDirectory: true)

    static func url(_ relative: String) -> URL {
        root.appendingPathComponent(relative)
    }

    static func data(_ relative: String) throws -> Data {
        try Data(contentsOf: url(relative))
    }

    /// Every `*.json` under `shared/fixtures/<dir>` (sorted), excluding sidecars such as `*.truth.json`.
    static func jsonFiles(in dir: String) -> [URL] {
        let base = root.appendingPathComponent(dir, isDirectory: true)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: base.path) else { return [] }
        return names
            .filter { $0.hasSuffix(".json") && !$0.hasSuffix(".truth.json") }
            .sorted()
            .map { base.appendingPathComponent($0) }
    }

    /// Every fixture file anywhere under `shared/fixtures` whose top-level `schema` equals `schema`.
    static func files(withSchema schema: String) -> [URL] {
        guard let enumerator = FileManager.default.enumerator(atPath: root.path) else { return [] }
        var out: [URL] = []
        while let rel = enumerator.nextObject() as? String {
            guard rel.hasSuffix(".json") else { continue }
            let url = root.appendingPathComponent(rel)
            guard let data = try? Data(contentsOf: url),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  obj["schema"] as? String == schema
            else { continue }
            out.append(url)
        }
        return out.sorted { $0.path < $1.path }
    }
}

enum JSONPaths {
    /// Key paths (`a.b[].c`) of every non-null leaf, so a misnamed optional CodingKey (which would silently decode as
    /// nil and still round-trip) is caught by comparing the fixture's paths with the re-encoded paths.
    static func nonNullLeafPaths(_ data: Data) throws -> Set<String> {
        let obj = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        var out = Set<String>()
        collect(obj, prefix: "$", into: &out)
        return out
    }

    private static func collect(_ value: Any, prefix: String, into out: inout Set<String>) {
        if value is NSNull { return }
        if let dict = value as? [String: Any] {
            if dict.isEmpty { out.insert(prefix + "{}") }
            for (k, v) in dict { collect(v, prefix: prefix + "." + k, into: &out) }
        } else if let array = value as? [Any] {
            if array.isEmpty { out.insert(prefix + "[]") }
            for v in array { collect(v, prefix: prefix + "[]", into: &out) }
        } else {
            out.insert(prefix)
        }
    }
}

/// Decode → encode → decode, returning the first decoded value, the re-decoded value and both path sets.
func roundTrip<T: Codable & Equatable>(_ type: T.Type, _ data: Data) throws -> (original: T, again: T, fixturePaths: Set<String>, encodedPaths: Set<String>) {
    let decoder = JSONDecoder()
    let original = try decoder.decode(T.self, from: data)
    let encoded = try JSONEncoder().encode(original)
    let again = try decoder.decode(T.self, from: encoded)
    return (original, again, try JSONPaths.nonNullLeafPaths(data), try JSONPaths.nonNullLeafPaths(encoded))
}

// MARK: - Synthetic people

/// A standing person whose box is roughly `height` tall, centred at (cx, cy) in CFS.
func syntheticPerson(cx: Double, cy: Double, height: Double, conf: Double = 0.9, aspect: Double = 16.0 / 9.0) -> [Joint: Keypoint] {
    // Offsets in frame-height units relative to the centre (y down), x converted to width units.
    let layout: [(Joint, Double, Double)] = [
        (.nose, 0.0, -0.42), (.lEye, 0.02, -0.44), (.rEye, -0.02, -0.44), (.lEar, 0.04, -0.43), (.rEar, -0.04, -0.43),
        (.neck, 0.0, -0.33), (.lSho, 0.10, -0.32), (.rSho, -0.10, -0.32), (.lElb, 0.14, -0.15), (.rElb, -0.14, -0.15),
        (.lWri, 0.16, 0.0), (.rWri, -0.16, 0.0), (.root, 0.0, 0.02), (.lHip, 0.07, 0.02), (.rHip, -0.07, 0.02),
        (.lKne, 0.08, 0.22), (.rKne, -0.08, 0.22), (.lAnk, 0.08, 0.42), (.rAnk, -0.08, 0.42),
    ]
    var out: [Joint: Keypoint] = [:]
    for (j, dx, dy) in layout {
        out[j] = Keypoint(x: cx + dx * height / aspect, y: cy + dy * height, c: conf)
    }
    return out
}

func syntheticCandidate(cx: Double, cy: Double, height: Double, conf: Double = 0.9, aspect: Double = 16.0 / 9.0) -> PersonCandidate {
    guard let c = CandidateBuilder.build(joints: syntheticPerson(cx: cx, cy: cy, height: height, conf: conf, aspect: aspect), aspect: aspect) else {
        fatalError("synthetic person must build")
    }
    return c
}
