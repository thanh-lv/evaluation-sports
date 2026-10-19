import CoachCore
import Foundation

/// Every error a service hands to the UI. Supabase SDK errors are converted in `SupabaseErrorMapping.swift`
/// (`AppError.from(supabase:)`); this file is Foundation-only so the mapping to user-facing copy is unit-testable.
enum AppError: Error, Sendable, Equatable {
    /// A non-2xx answer with the contracts error body (`ApiError`, `common.ts`), a PostgREST/Postgres error whose
    /// message is a contracts code (`PT403 forbidden`) or a profile check (`under_min_age`), or a GoTrue error code
    /// prefixed with `auth.` (`auth.otp_expired`).
    case api(ApiError, status: Int)
    /// No network, DNS failure, connection lost.
    case offline
    case timeout
    /// No Supabase session (anonymous sign-in has not succeeded yet) or the session was rejected.
    case notSignedIn
    /// The build has no usable backend configuration (`AppConfiguration.problems`).
    case notConfigured
    /// The server answered with something the app cannot decode (contract drift).
    case decoding(String)
    /// A non-2xx answer without a contracts body (gateway errors, HTML pages).
    case server(status: Int)
    case cancelled
    case unknown(String)

    /// The contracts error code, when there is one.
    var apiErrorCode: ApiErrorCode? {
        if case .api(let body, _) = self { return body.knownCode }
        return nil
    }

    /// The raw code string (`under_min_age`, `forbidden`, `auth.otp_expired`, …).
    var codeString: String? {
        if case .api(let body, _) = self { return body.code }
        return nil
    }

    var apiBody: ApiError? {
        if case .api(let body, _) = self { return body }
        return nil
    }

    var httpStatus: Int? {
        switch self {
        case .api(_, let status), .server(let status): return status
        default: return nil
        }
    }

    /// Recording tips the server attached (prepare rejections), as String Catalog keys.
    var tips: [TipKey] { apiBody?.tipKeys ?? [] }

    /// A prepare rejection (422 with tips): no quota was used; show the message and the tips.
    var isPrepareRejection: Bool { apiErrorCode?.isPrepareRejection ?? false }

    /// Worth retrying automatically later (network or transient server problems), not a definitive answer.
    var isTransient: Bool {
        switch self {
        case .offline, .timeout: return true
        case .server(let status): return status >= 500 || status == 408 || status == 429
        case .api(let body, let status):
            switch body.knownCode {
            case .upstreamUnavailable, .busyTryLater, .internal, .rateLimited: return true
            default: return status >= 500
            }
        default: return false
        }
    }

    /// String Catalog key of the message shown to the user (`Resources/Strings/errors.json`).
    var messageKey: String {
        switch self {
        case .api(let body, let status):
            if let known = body.knownCode { return AppError.messageKey(for: known) }
            if let key = AppError.extraMessageKeys[body.code] { return key }
            if body.code.hasPrefix("auth.") { return "error.auth.generic" }
            return status >= 500 ? "error.server" : "error.generic"
        case .offline: return "error.offline"
        case .timeout: return "error.timeout"
        case .notSignedIn: return "error.not_signed_in"
        case .notConfigured: return "error.not_configured"
        case .decoding: return "error.decoding"
        case .server: return "error.server"
        case .cancelled: return "error.cancelled"
        case .unknown: return "error.generic"
        }
    }

    /// `error.<code>` for every contracts code (all defined in errors.json; checked by the unit tests and
    /// scripts/check_ios_resources.py).
    static func messageKey(for code: ApiErrorCode) -> String {
        "error.\(code.rawValue)"
    }

    /// Codes outside `ApiErrorCode` that have their own message.
    static let extraMessageKeys: [String: String] = [
        "under_min_age": "error.under_min_age",
        "age_attestation_required": "error.age_attestation_required",
        "auth.otp_expired": "error.auth.otp_invalid",
        "auth.invalid_credentials": "error.auth.otp_invalid",
        "auth.email_address_invalid": "error.auth.email_invalid",
        "auth.validation_failed": "error.auth.email_invalid",
        "auth.email_exists": "error.auth.identity_exists",
        "auth.identity_already_exists": "error.auth.identity_exists",
        "auth.user_already_exists": "error.auth.identity_exists",
        "auth.manual_linking_disabled": "error.auth.linking_disabled",
        "auth.anonymous_provider_disabled": "error.auth.linking_disabled",
        "auth.email_provider_disabled": "error.auth.linking_disabled",
        "auth.provider_disabled": "error.auth.linking_disabled",
    ]

    /// The localized message in the app language.
    var localizedMessage: String { L10n.string(messageKey) }

    /// Converts any error (URLError, decoding, cancellation, already an AppError) into an AppError. Errors from the
    /// Supabase SDK are handled by `AppError.from(supabase:)` first, which falls back to this.
    static func from(_ error: Error) -> AppError {
        if let appError = error as? AppError { return appError }
        if let apiError = error as? ApiError { return .api(apiError, status: apiError.knownCode?.httpStatus ?? 400) }
        if error is CancellationError { return .cancelled }
        if let urlError = error as? URLError { return from(urlError: urlError) }
        if error is DecodingError { return .decoding(String(describing: error)) }
        // On Apple platforms an NSError in NSURLErrorDomain bridges to URLError through the cast above.
        return .unknown(String(describing: error))
    }

    static func from(urlError: URLError) -> AppError {
        switch urlError.code {
        case .cancelled: return .cancelled
        case .timedOut: return .timeout
        case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
             .internationalRoamingOff, .dataNotAllowed, .callIsActive, .secureConnectionFailed:
            return .offline
        default: return .unknown(urlError.localizedDescription)
        }
    }

    /// Decodes a contracts error body (`{code, message?, tips?, limit?, used?, resetsAt?}`) from a non-2xx answer.
    static func fromResponse(status: Int, data: Data) -> AppError {
        if let body = try? JSONDecoder().decode(ApiError.self, from: data), !body.code.isEmpty {
            if status == 401 && body.knownCode == .unauthorized { return .notSignedIn }
            return .api(body, status: status)
        }
        if status == 401 { return .notSignedIn }
        return .server(status: status)
    }

    /// PostgREST error code + message → AppError (`PostgrestError.code`, `.message`).
    static func from(postgrestCode code: String?, message: String) -> AppError {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if let code, code.hasPrefix("PT"), let status = Int(code.dropFirst(2)) {
            if status == 401 { return .notSignedIn }
            return .api(ApiError(code: trimmed.isEmpty ? "http_\(status)" : trimmed), status: status)
        }
        // JWT expired or invalid (PGRST301, PGRST302, PGRST303).
        if let code, code.hasPrefix("PGRST30") { return .notSignedIn }
        if AppError.profileCheckCodes.contains(trimmed) {
            return .api(ApiError(code: trimmed), status: 400)
        }
        if let known = ApiErrorCode(rawValue: trimmed) {
            return .api(ApiError(code: known.rawValue), status: known.httpStatus)
        }
        // 23505 unique_violation (e.g. a second thumbs rating for the same analysis).
        if code == "23505" { return .api(ApiError(code: "duplicate"), status: 409) }
        // 42501 insufficient_privilege (RLS or a missing grant) → forbidden.
        if code == "42501" { return .api(ApiError(code: ApiErrorCode.forbidden.rawValue), status: 403) }
        return .unknown("postgrest \(code ?? "?"): \(trimmed)")
    }

    /// Raised by the `profiles` birth-year trigger (`23514`).
    static let profileCheckCodes: Set<String> = ["under_min_age", "age_attestation_required"]
}

extension AppError: LocalizedError {
    var errorDescription: String? { localizedMessage }
}
