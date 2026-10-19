import CoachCore
import Foundation

/// Every error a service hands to the UI. Supabase-specific errors are converted in `SupabaseErrorMapping.swift`;
/// this file is Foundation-only so the mapping to user-facing copy is unit-testable.
enum AppError: Error, Sendable, Equatable {
    /// A non-2xx answer with the contracts' error body (`ApiError`, `common.ts`), or a PostgREST/Postgres error whose
    /// message is a contracts code (`PT403 forbidden`) or a profile check (`under_min_age`).
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

    /// The raw code string (`under_min_age`, `forbidden`, …).
    var codeString: String? {
        if case .api(let body, _) = self { return body.code }
        return nil
    }

    var apiBody: ApiError? {
        if case .api(let body, _) = self { return body }
        return nil
    }

    /// Recording tips the server attached (prepare rejections), as String Catalog keys.
    var tips: [TipKey] { apiBody?.tipKeys ?? [] }

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

    /// String Catalog key of the message shown to the user (`errors.json`).
    var messageKey: String {
        switch self {
        case .api(let body, let status):
            if let known = body.knownCode { return AppError.messageKey(for: known) }
            switch body.code {
            case "under_min_age": return "error.under_min_age"
            case "age_attestation_required": return "error.age_attestation_required"
            default: return status >= 500 ? "error.server" : "error.generic"
            }
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

    static func messageKey(for code: ApiErrorCode) -> String {
        "error.\(code.rawValue)"
    }

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
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain { return from(urlError: URLError(URLError.Code(rawValue: nsError.code))) }
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
            return .api(body, status: status)
        }
        if status == 401 { return .notSignedIn }
        return .server(status: status)
    }
}

extension AppError: LocalizedError {
    var errorDescription: String? { localizedMessage }
}
