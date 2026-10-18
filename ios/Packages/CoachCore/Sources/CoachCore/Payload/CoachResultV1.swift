import Foundation

/// `coach-result.v1`: the stored result returned by `rpc get_result(id)`, redacted by tier (DESIGN.md §7.5,
/// `shared/schemas/coach-result.v1.json`). Server → client: nullable fields decode from `null` or a missing key;
/// `checkpoints` is absent for free access.
///
/// Semantics: `hero` is the first weakness and is not repeated in `weaknesses`; plan priority 1 addresses the hero;
/// free access shows at most 1 strength, empty `weaknesses`/`plan` and the hidden counts in `locked`;
/// display scores are multiples of 5.
public struct CoachResultV1: Codable, Sendable, Hashable {
    public static let schemaId = "coach-result.v1"

    public var schema: String
    public var analysisId: String
    public var sport: Sport
    public var skill: String
    /// Language of model-written text (summary, titles, observations).
    public var narrativeLanguage: Language
    /// ISO 8601 UTC.
    public var createdAt: String
    public var status: Status
    public var rejection: Rejection?
    public var access: Access
    public var locked: Locked
    public var aiGenerated: Bool
    public var hero: Hero?
    public var overall: Overall
    public var subScores: [SubScore]
    /// Full access only.
    public var checkpoints: [Checkpoint]?
    public var strengths: [Strength]
    public var weaknesses: [Weakness]
    public var plan: [PlanItem]
    public var strokes: [Stroke]
    public var safety: [SafetyNote]
    public var notAssessable: [NotAssessable]
    public var recordingTips: [String]
    public var rulesTip: LocalizedText
    public var summary: String
    public var meta: Meta

    public init(
        analysisId: String,
        sport: Sport,
        skill: String,
        narrativeLanguage: Language,
        createdAt: String,
        status: Status,
        rejection: Rejection?,
        access: Access,
        locked: Locked,
        aiGenerated: Bool = true,
        hero: Hero?,
        overall: Overall,
        subScores: [SubScore],
        checkpoints: [Checkpoint]?,
        strengths: [Strength],
        weaknesses: [Weakness],
        plan: [PlanItem],
        strokes: [Stroke],
        safety: [SafetyNote],
        notAssessable: [NotAssessable],
        recordingTips: [String],
        rulesTip: LocalizedText,
        summary: String,
        meta: Meta
    ) {
        self.schema = CoachResultV1.schemaId
        self.analysisId = analysisId
        self.sport = sport
        self.skill = skill
        self.narrativeLanguage = narrativeLanguage
        self.createdAt = createdAt
        self.status = status
        self.rejection = rejection
        self.access = access
        self.locked = locked
        self.aiGenerated = aiGenerated
        self.hero = hero
        self.overall = overall
        self.subScores = subScores
        self.checkpoints = checkpoints
        self.strengths = strengths
        self.weaknesses = weaknesses
        self.plan = plan
        self.strokes = strokes
        self.safety = safety
        self.notAssessable = notAssessable
        self.recordingTips = recordingTips
        self.rulesTip = rulesTip
        self.summary = summary
        self.meta = meta
    }

    public enum Status: String, Codable, Sendable, CaseIterable {
        case succeeded, rejected
    }

    public enum Access: String, Codable, Sendable, CaseIterable {
        case full, free
    }

    /// Contracts `RESULT_REJECTION_CODES`.
    public enum RejectionCode: String, Codable, Sendable, CaseIterable {
        case notAssessable = "not_assessable"
        case wrongSport = "wrong_sport"
        case wrongSkill = "wrong_skill"
    }

    public struct Rejection: Codable, Sendable, Hashable {
        public var code: RejectionCode
        /// String Catalog keys (`TipKey` raw values); kept as strings so an unknown key never breaks decoding.
        public var tips: [String]

        public init(code: RejectionCode, tips: [String]) {
            self.code = code
            self.tips = tips
        }

        public var tipKeys: [TipKey] { tips.compactMap(TipKey.init(rawValue:)) }
    }

    /// Hidden counts for free access (all zero for full access).
    public struct Locked: Codable, Sendable, Hashable {
        public var strengths: Int
        public var weaknesses: Int
        public var plan: Int

        public init(strengths: Int, weaknesses: Int, plan: Int) {
            self.strengths = strengths
            self.weaknesses = weaknesses
            self.plan = plan
        }

        public var total: Int { strengths + weaknesses + plan }
    }

    public struct EvidenceDetail: Codable, Sendable, Hashable {
        public var valueText: String
        public var targetText: String

        public init(valueText: String, targetText: String) {
            self.valueText = valueText
            self.targetText = targetText
        }
    }

    public struct Evidence: Codable, Sendable, Hashable {
        /// -1 = whole clip.
        public var strokeId: Int
        /// Phase time of the referenced stroke; nil for whole-clip evidence.
        public var tUs: Int64?
        /// F# (best stroke) or L# (worst stroke); nil when no frame applies.
        public var frameId: FrameId?
        /// Checkpoint id; nil for a visual-only observation.
        public var metricKey: String?
        /// Model text in `narrativeLanguage`, digit-free.
        public var observation: String
        public var plain: LocalizedText?
        /// Measured value and target, shown under "Chi tiết".
        public var detail: EvidenceDetail?
        public var joints: [Joint]

        public init(
            strokeId: Int,
            tUs: Int64?,
            frameId: FrameId?,
            metricKey: String?,
            observation: String,
            plain: LocalizedText?,
            detail: EvidenceDetail?,
            joints: [Joint]
        ) {
            self.strokeId = strokeId
            self.tUs = tUs
            self.frameId = frameId
            self.metricKey = metricKey
            self.observation = observation
            self.plain = plain
            self.detail = detail
            self.joints = joints
        }
    }

    public struct Dose: Codable, Sendable, Hashable {
        public var sets: Int
        public var reps: Int?
        public var seconds: Int?

        public init(sets: Int, reps: Int?, seconds: Int?) {
            self.sets = sets
            self.reps = reps
            self.seconds = seconds
        }
    }

    public struct Drill: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var title: LocalizedText
        public var steps: LocalizedList
        public var dose: Dose
        public var safety: LocalizedText?

        public init(id: String, title: LocalizedText, steps: LocalizedList, dose: Dose, safety: LocalizedText?) {
            self.id = id
            self.title = title
            self.steps = steps
            self.dose = dose
            self.safety = safety
        }
    }

    public struct Hero: Codable, Sendable, Hashable {
        public var checkpointId: String
        public var faultId: String?
        public var title: String
        public var observation: String
        public var cue: LocalizedText
        public var drill: Drill?
        public var frameId: FrameId?
        public var joints: [Joint]

        public init(
            checkpointId: String,
            faultId: String?,
            title: String,
            observation: String,
            cue: LocalizedText,
            drill: Drill?,
            frameId: FrameId?,
            joints: [Joint]
        ) {
            self.checkpointId = checkpointId
            self.faultId = faultId
            self.title = title
            self.observation = observation
            self.cue = cue
            self.drill = drill
            self.frameId = frameId
            self.joints = joints
        }
    }

    public struct Overall: Codable, Sendable, Hashable {
        /// nil when partial (coverage < 0.5).
        public var displayScore: Int?
        public var level: Level?
        public var coverage: Double
        public var partial: Bool
        public var beta: Bool

        public init(displayScore: Int?, level: Level?, coverage: Double, partial: Bool, beta: Bool = true) {
            self.displayScore = displayScore
            self.level = level
            self.coverage = coverage
            self.partial = partial
            self.beta = beta
        }
    }

    public struct SubScore: Codable, Sendable, Hashable, Identifiable {
        public var key: SubScoreKey
        /// nil = "Chưa đủ dữ liệu" (coverage < 0.4).
        public var displayScore: Int?
        public var coverage: Double
        public var confidence: Confidence
        public var name: LocalizedText

        public init(key: SubScoreKey, displayScore: Int?, coverage: Double, confidence: Confidence, name: LocalizedText) {
            self.key = key
            self.displayScore = displayScore
            self.coverage = coverage
            self.confidence = confidence
            self.name = name
        }

        public var id: SubScoreKey { key }
    }

    public struct PerStrokeValue: Codable, Sendable, Hashable {
        public var strokeId: Int
        public var value: Double?

        public init(strokeId: Int, value: Double?) {
            self.strokeId = strokeId
            self.value = value
        }
    }

    public struct Checkpoint: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var subscore: SubScoreKey
        public var assess: AssessTag
        /// Score 0…1; nil when not assessed.
        public var s: Double?
        /// Confidence 0…1.
        public var c: Double
        public var valueText: String
        public var targetText: String
        public var perStroke: [PerStrokeValue]
        public var name: LocalizedText
        public var joints: [Joint]

        public init(
            id: String,
            subscore: SubScoreKey,
            assess: AssessTag,
            s: Double?,
            c: Double,
            valueText: String,
            targetText: String,
            perStroke: [PerStrokeValue],
            name: LocalizedText,
            joints: [Joint]
        ) {
            self.id = id
            self.subscore = subscore
            self.assess = assess
            self.s = s
            self.c = c
            self.valueText = valueText
            self.targetText = targetText
            self.perStroke = perStroke
            self.name = name
            self.joints = joints
        }
    }

    public struct Strength: Codable, Sendable, Hashable {
        public var checkpointId: String
        public var title: String
        public var detail: String
        public var evidence: [Evidence]

        public init(checkpointId: String, title: String, detail: String, evidence: [Evidence]) {
            self.checkpointId = checkpointId
            self.title = title
            self.detail = detail
            self.evidence = evidence
        }
    }

    public struct Weakness: Codable, Sendable, Hashable {
        public var checkpointId: String
        public var faultId: String?
        public var severity: Severity
        public var title: String
        public var detail: String
        public var whyItMatters: String
        public var cue: LocalizedText
        public var evidence: [Evidence]

        public init(
            checkpointId: String,
            faultId: String?,
            severity: Severity,
            title: String,
            detail: String,
            whyItMatters: String,
            cue: LocalizedText,
            evidence: [Evidence]
        ) {
            self.checkpointId = checkpointId
            self.faultId = faultId
            self.severity = severity
            self.title = title
            self.detail = detail
            self.whyItMatters = whyItMatters
            self.cue = cue
            self.evidence = evidence
        }
    }

    public struct PlanTarget: Codable, Sendable, Hashable {
        public var metricKey: String
        /// Server-formatted display text.
        public var current: String
        public var goal: String

        public init(metricKey: String, current: String, goal: String) {
            self.metricKey = metricKey
            self.current = current
            self.goal = goal
        }
    }

    public struct PlanItem: Codable, Sendable, Hashable {
        public var priority: Int
        public var faultId: String?
        public var title: String
        public var howToFix: String
        public var cues: [String]
        public var goal: String
        /// nil for visual items.
        public var target: PlanTarget?
        public var drills: [Drill]

        public init(
            priority: Int,
            faultId: String?,
            title: String,
            howToFix: String,
            cues: [String],
            goal: String,
            target: PlanTarget?,
            drills: [Drill]
        ) {
            self.priority = priority
            self.faultId = faultId
            self.title = title
            self.howToFix = howToFix
            self.cues = cues
            self.goal = goal
            self.target = target
            self.drills = drills
        }
    }

    public struct Stroke: Codable, Sendable, Hashable, Identifiable {
        public var id: Int
        public var tStartUs: Int64
        public var tContactUs: Int64
        public var contactIsEstimate: Bool
        public var tEndUs: Int64
        public var phases: StrokePhasesUs
        public var role: StrokeRole?

        public init(id: Int, tStartUs: Int64, tContactUs: Int64, contactIsEstimate: Bool, tEndUs: Int64, phases: StrokePhasesUs, role: StrokeRole?) {
            self.id = id
            self.tStartUs = tStartUs
            self.tContactUs = tContactUs
            self.contactIsEstimate = contactIsEstimate
            self.tEndUs = tEndUs
            self.phases = phases
            self.role = role
        }
    }

    public struct SafetyNote: Codable, Sendable, Hashable {
        public var kind: SafetyKind
        /// In `narrativeLanguage`.
        public var message: String
        /// Fixed injury-flag notes from the rubric (follows the UI language).
        public var localized: LocalizedText?
        public var checkpointId: String?

        public init(kind: SafetyKind, message: String, localized: LocalizedText?, checkpointId: String?) {
            self.kind = kind
            self.message = message
            self.localized = localized
            self.checkpointId = checkpointId
        }
    }

    public struct NotAssessable: Codable, Sendable, Hashable {
        public var aspect: String
        public var howToCapture: String

        public init(aspect: String, howToCapture: String) {
            self.aspect = aspect
            self.howToCapture = howToCapture
        }
    }

    public struct Meta: Codable, Sendable, Hashable {
        public var model: String
        public var kind: AnalysisKind
        public var promptVersion: String
        public var rubricVersion: String
        public var algoVersion: String
        public var schemaVersion: String

        public init(model: String, kind: AnalysisKind, promptVersion: String, rubricVersion: String, algoVersion: String, schemaVersion: String) {
            self.model = model
            self.kind = kind
            self.promptVersion = promptVersion
            self.rubricVersion = rubricVersion
            self.algoVersion = algoVersion
            self.schemaVersion = schemaVersion
        }
    }
}

extension CoachResultV1 {
    public var isFree: Bool { access == .free }

    /// The stroke with the given role, if any.
    public func stroke(role: StrokeRole) -> Stroke? { strokes.first { $0.role == role } }

    /// Every evidence item that points at a key frame, for prefetching local frames.
    public var allEvidence: [Evidence] {
        strengths.flatMap(\.evidence) + weaknesses.flatMap(\.evidence)
    }
}
