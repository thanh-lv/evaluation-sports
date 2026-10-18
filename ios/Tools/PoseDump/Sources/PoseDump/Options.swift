import CoachCore
import Foundation

// Vision (macOS 15 SDK) and MacTypes declare `Joint`, `Point` and `Rect` too; module-level aliases pin CoachCore's.
typealias Joint = CoachCore.Joint
typealias Point = CoachCore.Point
typealias Rect = CoachCore.Rect

/// How the target player is chosen at the first frame (within 3 s of the segment start) that contains people.
enum SelectMode: Equatable {
    /// DESIGN.md §5.4 auto rule; exits with code 2 when the clip is ambiguous.
    case auto
    /// A tap in CFS-normalized display coordinates (0…1, top-left origin).
    case tap(Point)
}

struct OptionsError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Command-line options. Pure parsing (no AVFoundation), so it can be reasoned about and tested anywhere.
struct Options {
    var input: URL
    var output: URL
    var skill: String
    var sport: Sport
    var select: SelectMode = .auto
    /// nil → 60 Hz when the source is ≥ 50 fps, else 30 Hz (no device benchmark offline).
    var hz: Int?
    var startSec: Double?
    var endSec: Double?
    var handedness: Handedness = .right
    var view: CameraView = .auto
    var level: Level?
    var language: Language = .vi
    var source: PoseV1.Source = .imported
    var analysisId: String = IDs.newId()
    var useRoi = true
    var roiRelative = true
    var pretty = false
    var verbose = false

    static let usage = """
    Usage: posedump <clip.mov> --skill <bd.xxx|pb.xxx> [options]

      --select auto|x,y       target selection: auto rule, or a tap at normalized x,y (0..1, top-left) (default auto)
      --hz 30|60              analysis rate (default: 60 if the source is >= 50 fps, else 30)
      --out <path>            output file (default: <clip>.pose.json next to the input)
      --start <s> --end <s>   analysed segment in seconds on the clip timeline (default: whole clip; 3..32 s)
      --handedness right|left (default right)
      --view side|behind|front|diagonal|auto (default auto)
      --level beginner|improving|intermediate|advanced
      --language vi|en        (default vi)
      --source recorded|imported (default imported)
      --analysis-id <uuid>    (default: random, lowercased)
      --roi on|off            crop-follow regionOfInterest (default on)
      --roi-coords relative|absolute  how Vision reports points when a ROI is set (default relative; verify on device)
      --pretty                pretty-print the JSON (large)
      --verbose               per-frame log on stderr
    Exit codes: 0 ok, 1 error, 2 ambiguous auto-selection (rerun with --select x,y), 3 written but rejected by the
    on-device quality gate.
    """

    static func parse(_ args: [String]) throws -> Options {
        var positional: [String] = []
        var values: [String: String] = [:]
        var flags = Set<String>()
        let valueKeys: Set<String> = [
            "--select", "--hz", "--out", "--start", "--end", "--handedness", "--view", "--level", "--language",
            "--source", "--analysis-id", "--roi", "--roi-coords", "--skill",
        ]
        let flagKeys: Set<String> = ["--pretty", "--verbose", "--help", "-h"]
        var i = 0
        while i < args.count {
            let a = args[i]
            if valueKeys.contains(a) {
                guard i + 1 < args.count else { throw OptionsError("missing value for \(a)") }
                values[a] = args[i + 1]
                i += 2
            } else if flagKeys.contains(a) {
                flags.insert(a)
                i += 1
            } else if a.hasPrefix("--") {
                throw OptionsError("unknown option \(a)")
            } else {
                positional.append(a)
                i += 1
            }
        }
        if flags.contains("--help") || flags.contains("-h") { throw OptionsError(usage) }
        guard positional.count == 1, let inputPath = positional.first else { throw OptionsError("expected exactly one input file\n\n\(usage)") }
        guard let skill = values["--skill"] else { throw OptionsError("--skill is required (e.g. bd.clear_fh)") }
        guard skill.range(of: #"^(bd|pb)\.[a-z0-9_]+$"#, options: .regularExpression) != nil, let sport = Sport.of(skill: skill) else {
            throw OptionsError("--skill must look like bd.<skill> or pb.<skill>")
        }

        let input = URL(fileURLWithPath: inputPath)
        let output: URL
        if let out = values["--out"] {
            output = URL(fileURLWithPath: out)
        } else {
            output = input.deletingPathExtension().appendingPathExtension("pose.json")
        }
        var o = Options(input: input, output: output, skill: skill, sport: sport)

        if let s = values["--select"] { o.select = try parseSelect(s) }
        if let h = values["--hz"] {
            guard let hz = Int(h), PoseV1.analysisRates.contains(hz) else { throw OptionsError("--hz must be 30 or 60") }
            o.hz = hz
        }
        if let s = values["--start"] {
            guard let v = Double(s), v.isFinite, v >= 0 else { throw OptionsError("--start must be seconds >= 0") }
            o.startSec = v
        }
        if let s = values["--end"] {
            guard let v = Double(s), v.isFinite, v > 0 else { throw OptionsError("--end must be seconds > 0") }
            o.endSec = v
        }
        if let s = values["--handedness"] { o.handedness = try parseEnum(Handedness.self, s, "--handedness") }
        if let s = values["--view"] { o.view = try parseEnum(CameraView.self, s, "--view") }
        if let s = values["--level"] { o.level = try parseEnum(Level.self, s, "--level") }
        if let s = values["--language"] { o.language = try parseEnum(Language.self, s, "--language") }
        if let s = values["--source"] { o.source = try parseEnum(PoseV1.Source.self, s, "--source") }
        if let s = values["--analysis-id"] {
            guard let id = IDs.lower(s) else { throw OptionsError("--analysis-id must be a UUID") }
            o.analysisId = id
        }
        if let s = values["--roi"] {
            guard s == "on" || s == "off" else { throw OptionsError("--roi must be on or off") }
            o.useRoi = s == "on"
        }
        if let s = values["--roi-coords"] {
            guard s == "relative" || s == "absolute" else { throw OptionsError("--roi-coords must be relative or absolute") }
            o.roiRelative = s == "relative"
        }
        o.pretty = flags.contains("--pretty")
        o.verbose = flags.contains("--verbose")
        return o
    }

    static func parseSelect(_ s: String) throws -> SelectMode {
        if s == "auto" { return .auto }
        let parts = s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2, let x = Double(parts[0]), let y = Double(parts[1]), (0...1).contains(x), (0...1).contains(y) else {
            throw OptionsError("--select must be auto or x,y with 0 <= x,y <= 1 (normalized, top-left origin)")
        }
        return .tap(Point(x: x, y: y))
    }

    private static func parseEnum<E: RawRepresentable & CaseIterable>(_ type: E.Type, _ s: String, _ name: String) throws -> E where E.RawValue == String {
        guard let v = E(rawValue: s) else {
            let allowed = E.allCases.map(\.rawValue).joined(separator: "|")
            throw OptionsError("\(name) must be one of \(allowed)")
        }
        return v
    }
}
