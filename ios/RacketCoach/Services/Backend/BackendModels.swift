import CoachCore
import Foundation

// Bodies of the client RPCs and tables (docs/database.md "Client RPCs", migration 0400/0500). The big contracts
// (pose.v1, prepare.v1, coach-result.v1, catalog.v1, …) are CoachCore types. Decoders are lenient: a missing key
// falls back to a safe default so a server-side addition never breaks an installed app.

// MARK: - my_status()

/// `rpc("my_status")`: quota, entitlement, consent state and flags of the caller. The app gates features only on this
/// and on `get_result` (DESIGN.md §9.4 step 6).
struct MyStatus: Codable, Sendable, Hashable {
    struct Usage: Codable, Sendable, Hashable {
        var total: Int
        var standard: Int
        var retries: Int
    }

    struct Limits: Codable, Sendable, Hashable {
        var total: Int
        var standard: Int
        var retries: Int
        var inFlight: Int
    }

    /// `plan_limits.features`.
    struct Features: Codable, Sendable, Hashable {
        var fullReport: Bool
        var progress: Bool
        var player: Bool
        /// Free: the newest N results are shown in full in History; nil = unlimited.
        var historyFullLimit: Int?

        enum CodingKeys: String, CodingKey {
            case fullReport = "full_report"
            case progress, player
            case historyFullLimit = "history_full_limit"
        }

        init(fullReport: Bool, progress: Bool, player: Bool, historyFullLimit: Int?) {
            self.fullReport = fullReport
            self.progress = progress
            self.player = player
            self.historyFullLimit = historyFullLimit
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            fullReport = try c.decodeIfPresent(Bool.self, forKey: .fullReport) ?? false
            progress = try c.decodeIfPresent(Bool.self, forKey: .progress) ?? false
            player = try c.decodeIfPresent(Bool.self, forKey: .player) ?? false
            historyFullLimit = try c.decodeIfPresent(Int.self, forKey: .historyFullLimit)
        }
    }

    /// Paywall copy numbers per tier (`copy.free|trial|premium`).
    struct PlanCopy: Codable, Sendable, Hashable {
        var periodType: CatalogPlan.PeriodType
        var totalLimit: Int
        var standardLimit: Int
    }

    struct Entitlement: Codable, Sendable, Hashable {
        var isTrial: Bool
        var productId: String?
        /// ISO 8601 (already coalesced with the grace period).
        var expiresAt: String?
        var willRenew: Bool
        var inGrace: Bool
        var billingIssue: Bool

        static let none = Entitlement(isTrial: false, productId: nil, expiresAt: nil, willRenew: false, inGrace: false, billingIssue: false)
    }

    struct ConsentItem: Codable, Sendable, Hashable {
        /// The version in `app_config.consent_versions`.
        var current: String?
        /// The version stored in the profile (nil = never accepted or withdrawn).
        var accepted: String?

        var isCurrent: Bool { accepted != nil && accepted == current }
    }

    struct ConsentStatus: Codable, Sendable, Hashable {
        var pdpl: ConsentItem
        var ai: ConsentItem
        /// Both accepted at the current versions; `submit` answers 403 `consent_required` otherwise.
        var upToDate: Bool

        /// The user accepted an earlier version of at least one text (show the "we've updated" wording).
        var isReconsent: Bool {
            (pdpl.accepted != nil && !pdpl.isCurrent) || (ai.accepted != nil && !ai.isCurrent)
        }
    }

    var tier: Tier
    var periodType: CatalogPlan.PeriodType
    var periodKey: String?
    var used: Usage
    var limits: Limits
    var remaining: Int
    var inFlight: Int
    var nextKind: AnalysisKind
    /// ISO 8601 with +07:00; nil for the trial (the trial never resets).
    var resetsAt: String?
    /// The free first-ever advanced analysis is still available.
    var bonusAvailable: Bool
    var features: Features
    var copy: [String: PlanCopy]
    var entitlement: Entitlement
    var consent: ConsentStatus
    var isReviewer: Bool
    var isAnonymous: Bool

    enum CodingKeys: String, CodingKey {
        case tier, periodType, periodKey, used, limits, remaining, inFlight, nextKind
        case resetsAt = "resets_at"
        case bonusAvailable, features, copy, entitlement, consent, isReviewer, isAnonymous
    }

    init(
        tier: Tier, periodType: CatalogPlan.PeriodType, periodKey: String?, used: Usage, limits: Limits, remaining: Int,
        inFlight: Int, nextKind: AnalysisKind, resetsAt: String?, bonusAvailable: Bool, features: Features,
        copy: [String: PlanCopy], entitlement: Entitlement, consent: ConsentStatus, isReviewer: Bool, isAnonymous: Bool
    ) {
        self.tier = tier
        self.periodType = periodType
        self.periodKey = periodKey
        self.used = used
        self.limits = limits
        self.remaining = remaining
        self.inFlight = inFlight
        self.nextKind = nextKind
        self.resetsAt = resetsAt
        self.bonusAvailable = bonusAvailable
        self.features = features
        self.copy = copy
        self.entitlement = entitlement
        self.consent = consent
        self.isReviewer = isReviewer
        self.isAnonymous = isAnonymous
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tier = try c.decode(Tier.self, forKey: .tier)
        periodType = try c.decodeIfPresent(CatalogPlan.PeriodType.self, forKey: .periodType) ?? .calendarMonth
        periodKey = try c.decodeIfPresent(String.self, forKey: .periodKey)
        used = try c.decodeIfPresent(Usage.self, forKey: .used) ?? Usage(total: 0, standard: 0, retries: 0)
        limits = try c.decode(Limits.self, forKey: .limits)
        remaining = try c.decode(Int.self, forKey: .remaining)
        inFlight = try c.decodeIfPresent(Int.self, forKey: .inFlight) ?? 0
        nextKind = try c.decodeIfPresent(AnalysisKind.self, forKey: .nextKind) ?? .basic
        resetsAt = try c.decodeIfPresent(String.self, forKey: .resetsAt)
        bonusAvailable = try c.decodeIfPresent(Bool.self, forKey: .bonusAvailable) ?? false
        features = try c.decodeIfPresent(Features.self, forKey: .features)
            ?? Features(fullReport: false, progress: false, player: false, historyFullLimit: 3)
        copy = try c.decodeIfPresent([String: PlanCopy].self, forKey: .copy) ?? [:]
        entitlement = try c.decodeIfPresent(Entitlement.self, forKey: .entitlement) ?? .none
        consent = try c.decodeIfPresent(ConsentStatus.self, forKey: .consent)
            ?? ConsentStatus(pdpl: ConsentItem(current: nil, accepted: nil), ai: ConsentItem(current: nil, accepted: nil), upToDate: false)
        isReviewer = try c.decodeIfPresent(Bool.self, forKey: .isReviewer) ?? false
        isAnonymous = try c.decodeIfPresent(Bool.self, forKey: .isAnonymous) ?? true
    }

    /// Premium or trial.
    var isPaid: Bool { tier != .free }
    var resetsAtDate: Date? { L10nFormat.parseISO8601(resetsAt) }
    var planCopy: (free: PlanCopy?, trial: PlanCopy?, premium: PlanCopy?) {
        (copy[Tier.free.rawValue], copy[Tier.trial.rawValue], copy[Tier.premium.rawValue])
    }
}

// MARK: - app_config

/// The public `app_config` rows the app needs (readable by everyone, docs/database.md).
struct AppConfigValues: Sendable, Hashable, Codable {
    struct ConsentVersions: Sendable, Hashable, Codable {
        var pdpl: String
        var ai: String
    }

    /// D21: minimum user age (birth-year gate).
    var minUserAge: Int
    var consentVersions: ConsentVersions?

    /// Used before the first successful fetch (offline first launch). Matches `supabase/seed.sql`.
    static let fallback = AppConfigValues(minUserAge: 18, consentVersions: nil)

    /// Builds the values from `select key, value from app_config`.
    init(rows: [AppConfigRow]) {
        var minAge = AppConfigValues.fallback.minUserAge
        var versions: ConsentVersions?
        for row in rows {
            switch row.key {
            case "min_user_age":
                if let age = row.value.intValue { minAge = age }
            case "consent_versions":
                if let pdpl = row.value["pdpl"]?.stringValue, let ai = row.value["ai"]?.stringValue {
                    versions = ConsentVersions(pdpl: pdpl, ai: ai)
                }
            default:
                break
            }
        }
        minUserAge = minAge
        consentVersions = versions
    }

    init(minUserAge: Int, consentVersions: ConsentVersions?) {
        self.minUserAge = minUserAge
        self.consentVersions = consentVersions
    }
}

struct AppConfigRow: Codable, Sendable, Hashable {
    var key: String
    var value: JSONValue
}

// MARK: - profiles

/// One row of `public.profiles` (SELECT own).
struct Profile: Codable, Sendable, Hashable {
    var id: String
    var locale: Language?
    var handedness: Handedness?
    var level: Level?
    var birthYear: Int?
    var ageAttested: Bool
    var pdplConsentVersion: String?
    var pdplConsentAt: String?
    var aiConsentVersion: String?
    var aiConsentAt: String?
    var calibrationOptIn: Bool
    var consumptionConsent: Bool
    var isReviewer: Bool

    enum CodingKeys: String, CodingKey {
        case id, locale, handedness, level
        case birthYear = "birth_year"
        case ageAttested = "age_attested"
        case pdplConsentVersion = "pdpl_consent_version"
        case pdplConsentAt = "pdpl_consent_at"
        case aiConsentVersion = "ai_consent_version"
        case aiConsentAt = "ai_consent_at"
        case calibrationOptIn = "calibration_opt_in"
        case consumptionConsent = "consumption_consent"
        case isReviewer = "is_reviewer"
    }

    init(
        id: String, locale: Language? = nil, handedness: Handedness? = nil, level: Level? = nil, birthYear: Int? = nil,
        ageAttested: Bool = false, pdplConsentVersion: String? = nil, pdplConsentAt: String? = nil,
        aiConsentVersion: String? = nil, aiConsentAt: String? = nil, calibrationOptIn: Bool = false,
        consumptionConsent: Bool = false, isReviewer: Bool = false
    ) {
        self.id = id
        self.locale = locale
        self.handedness = handedness
        self.level = level
        self.birthYear = birthYear
        self.ageAttested = ageAttested
        self.pdplConsentVersion = pdplConsentVersion
        self.pdplConsentAt = pdplConsentAt
        self.aiConsentVersion = aiConsentVersion
        self.aiConsentAt = aiConsentAt
        self.calibrationOptIn = calibrationOptIn
        self.consumptionConsent = consumptionConsent
        self.isReviewer = isReviewer
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rawId = try c.decode(String.self, forKey: .id)
        id = IDs.lower(rawId) ?? rawId.lowercased()
        locale = try c.decodeIfPresent(Language.self, forKey: .locale)
        handedness = try c.decodeIfPresent(Handedness.self, forKey: .handedness)
        level = try c.decodeIfPresent(Level.self, forKey: .level)
        birthYear = try c.decodeIfPresent(Int.self, forKey: .birthYear)
        ageAttested = try c.decodeIfPresent(Bool.self, forKey: .ageAttested) ?? false
        pdplConsentVersion = try c.decodeIfPresent(String.self, forKey: .pdplConsentVersion)
        pdplConsentAt = try c.decodeIfPresent(String.self, forKey: .pdplConsentAt)
        aiConsentVersion = try c.decodeIfPresent(String.self, forKey: .aiConsentVersion)
        aiConsentAt = try c.decodeIfPresent(String.self, forKey: .aiConsentAt)
        calibrationOptIn = try c.decodeIfPresent(Bool.self, forKey: .calibrationOptIn) ?? false
        consumptionConsent = try c.decodeIfPresent(Bool.self, forKey: .consumptionConsent) ?? false
        isReviewer = try c.decodeIfPresent(Bool.self, forKey: .isReviewer) ?? false
    }
}

/// A partial update of the client-writable profile columns (migration 0500 column grant). Each field is a double
/// optional: `nil` leaves the column unchanged, `.some(nil)` writes SQL null (e.g. withdrawing consent).
struct ProfilePatch: Encodable, Sendable, Hashable {
    var locale: Language??
    var handedness: Handedness??
    var level: Level??
    var birthYear: Int??
    var ageAttested: Bool?
    var pdplConsentVersion: String??
    var aiConsentVersion: String??
    var calibrationOptIn: Bool?
    var consumptionConsent: Bool?

    init(
        locale: Language?? = nil, handedness: Handedness?? = nil, level: Level?? = nil, birthYear: Int?? = nil,
        ageAttested: Bool? = nil, pdplConsentVersion: String?? = nil, aiConsentVersion: String?? = nil,
        calibrationOptIn: Bool? = nil, consumptionConsent: Bool? = nil
    ) {
        self.locale = locale
        self.handedness = handedness
        self.level = level
        self.birthYear = birthYear
        self.ageAttested = ageAttested
        self.pdplConsentVersion = pdplConsentVersion
        self.aiConsentVersion = aiConsentVersion
        self.calibrationOptIn = calibrationOptIn
        self.consumptionConsent = consumptionConsent
    }

    enum CodingKeys: String, CodingKey {
        case locale, handedness, level
        case birthYear = "birth_year"
        case ageAttested = "age_attested"
        case pdplConsentVersion = "pdpl_consent_version"
        case aiConsentVersion = "ai_consent_version"
        case calibrationOptIn = "calibration_opt_in"
        case consumptionConsent = "consumption_consent"
    }

    var isEmpty: Bool {
        locale == nil && handedness == nil && level == nil && birthYear == nil && ageAttested == nil
            && pdplConsentVersion == nil && aiConsentVersion == nil && calibrationOptIn == nil && consumptionConsent == nil
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try Self.encode(locale, .locale, &c)
        try Self.encode(handedness, .handedness, &c)
        try Self.encode(level, .level, &c)
        try Self.encode(birthYear, .birthYear, &c)
        try c.encodeIfPresent(ageAttested, forKey: .ageAttested)
        try Self.encode(pdplConsentVersion, .pdplConsentVersion, &c)
        try Self.encode(aiConsentVersion, .aiConsentVersion, &c)
        try c.encodeIfPresent(calibrationOptIn, forKey: .calibrationOptIn)
        try c.encodeIfPresent(consumptionConsent, forKey: .consumptionConsent)
    }

    private static func encode<T: Encodable>(_ value: T??, _ key: CodingKeys, _ c: inout KeyedEncodingContainer<CodingKeys>) throws {
        guard let outer = value else { return }
        if let inner = outer {
            try c.encode(inner, forKey: key)
        } else {
            try c.encodeNil(forKey: key)
        }
    }
}

// MARK: - analyses (poll) and history/progress RPCs

/// The column-granted part of an `analyses` row (DESIGN.md §6.5 RLS), used by `poll`.
struct AnalysisRow: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var sport: Sport?
    var skill: String?
    var status: AnalysisStatus
    var failureCode: String?
    var cameraView: String?
    var subject: Subject?
    var createdAt: String?
    var completedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, sport, skill, status
        case failureCode = "failure_code"
        case cameraView = "camera_view"
        case subject
        case createdAt = "created_at"
        case completedAt = "completed_at"
    }

    /// Columns selected by `poll` (all are in the client column grant).
    static let pollColumns = "id,sport,skill,status,failure_code,camera_view,subject,created_at,completed_at"

    var isFinished: Bool { status == .succeeded || status == .rejected || status == .failed }
}

/// One item of `rpc("get_history")`. Free users get locked stubs (no score, level or title) past the newest 3.
struct HistoryItem: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var sport: Sport
    var skill: String
    var status: AnalysisStatus
    var subject: Subject?
    var cameraView: String?
    var failureCode: String?
    var createdAt: String
    var completedAt: String?
    var hasResult: Bool
    var locked: Bool
    var displayScore: Int?
    var level: Level?
    var partial: Bool?
    var heroTitle: String?
}

/// One point of `rpc("get_progress")` (premium or trial, `subject = self`).
struct ProgressPoint: Codable, Sendable, Hashable, Identifiable {
    struct SubScorePoint: Codable, Sendable, Hashable {
        var key: SubScoreKey
        var displayScore: Int?
    }

    var analysisId: String
    var skill: String
    var createdAt: String
    var displayScore: Int?
    var level: Level?
    var partial: Bool
    var subScores: [SubScorePoint]

    var id: String { analysisId }
}

/// Thumbs feedback on a result (`feedback` table; `user_id` defaults to `auth.uid()`).
struct FeedbackBody: Codable, Sendable, Hashable {
    var analysisId: String
    /// −1 or 1.
    var rating: Int
    /// At most 500 characters.
    var comment: String?

    enum CodingKeys: String, CodingKey {
        case analysisId = "analysis_id"
        case rating, comment
    }
}

// MARK: - frames

/// One rendered key frame to upload (`analysis-inputs/{uid}/{aid}/frames/F#.jpg`). Only F1–F5 are accepted.
struct FrameUpload: Sendable, Hashable {
    var frameId: FrameId
    /// A JPEG file on disk (written by the key-frame extractor), uploaded without loading it all into memory.
    var fileURL: URL

    init(frameId: FrameId, fileURL: URL) {
        self.frameId = frameId
        self.fileURL = fileURL
    }
}
