import Foundation

// Small HTTP bodies (contracts `api_v1.ts`, `common.ts` ApiError). Client → server optionals are omitted when nil;
// server → client optionals decode from `null` or a missing key.

// MARK: - Errors

/// Body of every non-2xx response. `code` stays a string so an unknown code still decodes; see `knownCode`.
public struct ApiError: Codable, Sendable, Hashable, Error {
    public var code: String
    public var message: String?
    /// String Catalog keys (`TipKey` raw values).
    public var tips: [String]?
    /// `quota_exceeded` (402) extras.
    public var limit: Int?
    public var used: Int?
    /// ISO 8601 with offset; nil when the period never resets (trial).
    public var resetsAt: String?

    public init(code: String, message: String? = nil, tips: [String]? = nil, limit: Int? = nil, used: Int? = nil, resetsAt: String? = nil) {
        self.code = code
        self.message = message
        self.tips = tips
        self.limit = limit
        self.used = used
        self.resetsAt = resetsAt
    }

    public var knownCode: ApiErrorCode? { ApiErrorCode(rawValue: code) }
    public var tipKeys: [TipKey] { (tips ?? []).compactMap(TipKey.init(rawValue:)) }
}

/// Contracts `API_ERROR_STATUS` keys.
public enum ApiErrorCode: String, Codable, Sendable, CaseIterable {
    case invalidPayload = "invalid_payload"
    case unauthorized
    case quotaExceeded = "quota_exceeded"
    case consentRequired = "consent_required"
    case forbidden
    case analysisNotFound = "analysis_not_found"
    case notFound = "not_found"
    case methodNotAllowed = "method_not_allowed"
    case analysisConflict = "analysis_conflict"
    case linkedToOtherAccount = "linked_to_other_account"
    case payloadTooLarge = "payload_too_large"
    case noStrokesDetected = "no_strokes_detected"
    case playerTooSmall = "player_too_small"
    case lowVisibility = "low_visibility"
    case tooFewFrames = "too_few_frames"
    case targetLost = "target_lost"
    case fpsTooLow = "fps_too_low"
    case clipTooShort = "clip_too_short"
    case clipTooLong = "clip_too_long"
    case skillNotAvailable = "skill_not_available"
    case framesMissing = "frames_missing"
    case inFlight = "in_flight"
    case rateLimited = "rate_limited"
    case transferRateLimited = "transfer_rate_limited"
    case `internal`
    case upstreamUnavailable = "upstream_unavailable"
    case busyTryLater = "busy_try_later"

    /// HTTP status the server uses for this code.
    public var httpStatus: Int {
        switch self {
        case .invalidPayload, .noStrokesDetected, .playerTooSmall, .lowVisibility, .tooFewFrames, .targetLost, .fpsTooLow,
             .clipTooShort, .clipTooLong, .skillNotAvailable, .framesMissing:
            return 422
        case .unauthorized: return 401
        case .quotaExceeded: return 402
        case .consentRequired, .forbidden: return 403
        case .analysisNotFound, .notFound: return 404
        case .methodNotAllowed: return 405
        case .analysisConflict, .linkedToOtherAccount: return 409
        case .payloadTooLarge: return 413
        case .inFlight, .rateLimited, .transferRateLimited: return 429
        case .internal: return 500
        case .upstreamUnavailable: return 502
        case .busyTryLater: return 503
        }
    }

    /// Prepare rejections (422 with tips; no quota used).
    public var isPrepareRejection: Bool {
        switch self {
        case .noStrokesDetected, .playerTooSmall, .lowVisibility, .tooFewFrames, .targetLost, .fpsTooLow, .clipTooShort,
             .clipTooLong, .skillNotAvailable:
            return true
        default:
            return false
        }
    }
}

// MARK: - GET /analyze/catalog

public struct CatalogResponseV1: Codable, Sendable, Hashable {
    public static let schemaId = "catalog.v1"

    public var schema: String
    public var skills: [CatalogSkill]
    public var plans: [CatalogPlan]

    public init(skills: [CatalogSkill], plans: [CatalogPlan]) {
        self.schema = CatalogResponseV1.schemaId
        self.skills = skills
        self.plans = plans
    }
}

public struct CatalogSkill: Codable, Sendable, Hashable, Identifiable {
    public struct Views: Codable, Sendable, Hashable {
        public var recommended: [ViewCode]
        public var allowed: [ViewCode]

        public init(recommended: [ViewCode], allowed: [ViewCode]) {
            self.recommended = recommended
            self.allowed = allowed
        }
    }

    public var id: String
    public var sport: Sport
    public var name: LocalizedText
    public var views: Views
    /// Share (0…1) of checkpoint weight assessable per view code (partial map keyed by `ViewCode` raw value).
    public var viewCoverage: [String: Double]
    /// Practisable alone (serves).
    public var solo: Bool

    public init(id: String, sport: Sport, name: LocalizedText, views: Views, viewCoverage: [String: Double], solo: Bool) {
        self.id = id
        self.sport = sport
        self.name = name
        self.views = views
        self.viewCoverage = viewCoverage
        self.solo = solo
    }

    public func coverage(for view: ViewCode) -> Double? { viewCoverage[view.rawValue] }
}

public struct CatalogPlan: Codable, Sendable, Hashable {
    public enum PeriodType: String, Codable, Sendable, CaseIterable {
        case calendarMonth = "calendar_month"
        case trial
        case subscriptionMonth = "subscription_month"
    }

    public var tier: Tier
    public var periodType: PeriodType
    public var totalLimit: Int
    public var standardLimit: Int

    public init(tier: Tier, periodType: PeriodType, totalLimit: Int, standardLimit: Int) {
        self.tier = tier
        self.periodType = periodType
        self.totalLimit = totalLimit
        self.standardLimit = standardLimit
    }
}

// MARK: - POST /analyze/submit

public struct SubmitRequest: Codable, Sendable, Hashable {
    public var analysisId: String
    /// DeviceCheck token, first-ever submit only.
    public var deviceCheckToken: String?

    public init(analysisId: UUID, deviceCheckToken: String? = nil) {
        self.analysisId = IDs.lower(analysisId)
        self.deviceCheckToken = deviceCheckToken
    }

    public init(analysisId: String, deviceCheckToken: String? = nil) {
        self.analysisId = IDs.lower(analysisId) ?? analysisId.lowercased()
        self.deviceCheckToken = deviceCheckToken
    }
}

public struct SubmitResponse: Codable, Sendable, Hashable {
    /// `queued`, `processing` or `succeeded`.
    public var status: AnalysisStatus
    public var pollAfterMs: Int

    public init(status: AnalysisStatus, pollAfterMs: Int) {
        self.status = status
        self.pollAfterMs = pollAfterMs
    }
}

// MARK: - POST /verify-subscription

public struct VerifySubscriptionRequest: Codable, Sendable, Hashable {
    public enum Reason: String, Codable, Sendable, CaseIterable {
        case purchase, restore, launch, update
    }

    /// StoreKit 2 `Transaction.jwsRepresentation`.
    public var signedTransaction: String
    public var reason: Reason

    public init(signedTransaction: String, reason: Reason) {
        self.signedTransaction = signedTransaction
        self.reason = reason
    }
}

public struct VerifySubscriptionResponse: Codable, Sendable, Hashable {
    public var tier: Tier
    public var productId: String?
    /// ISO 8601, coalesced with the grace period.
    public var expiresAt: String?
    public var willRenew: Bool
    public var inGrace: Bool
    public var billingIssue: Bool
    public var isTrial: Bool
    /// A restore moved the subscription to this account.
    public var transferred: Bool

    public init(tier: Tier, productId: String?, expiresAt: String?, willRenew: Bool, inGrace: Bool, billingIssue: Bool, isTrial: Bool, transferred: Bool) {
        self.tier = tier
        self.productId = productId
        self.expiresAt = expiresAt
        self.willRenew = willRenew
        self.inGrace = inGrace
        self.billingIssue = billingIssue
        self.isTrial = isTrial
        self.transferred = transferred
    }
}

// MARK: - Accounts

public struct AppleAuthExchangeRequest: Codable, Sendable, Hashable {
    public var authorizationCode: String

    public init(authorizationCode: String) {
        self.authorizationCode = authorizationCode
    }
}

/// Sent with the permanent account's JWT; the anonymous session's access token proves ownership.
public struct AccountMergeRequest: Codable, Sendable, Hashable {
    public var anonAccessToken: String

    public init(anonAccessToken: String) {
        self.anonAccessToken = anonAccessToken
    }
}

public struct AccountMergeResponse: Codable, Sendable, Hashable {
    public var merged: Bool

    public init(merged: Bool) {
        self.merged = merged
    }
}

/// `{confirm: true}`; the server rejects anything else.
public struct DeleteAccountRequest: Codable, Sendable, Hashable {
    public var confirm: Bool

    public init() {
        confirm = true
    }
}

public struct DeleteAccountResponse: Codable, Sendable, Hashable {
    public var deleted: Bool
    public var hadActiveSubscription: Bool
    /// No SIWA refresh token was stored: tell the user to revoke in Settings › Apple ID.
    public var siwaManualRevoke: Bool

    public init(deleted: Bool, hadActiveSubscription: Bool, siwaManualRevoke: Bool) {
        self.deleted = deleted
        self.hadActiveSubscription = hadActiveSubscription
        self.siwaManualRevoke = siwaManualRevoke
    }
}
