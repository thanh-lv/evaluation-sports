import CoachCore
import Foundation
import Supabase

extension AppError {
    /// Converts an error thrown by supabase-swift (Functions, PostgREST, Auth, Storage) into an `AppError`.
    ///
    /// - Edge Functions answer non-2xx with the contracts body `{code, message?, tips?, limit?, used?, resetsAt?}`.
    /// - Client RPCs raise `SQLSTATE 'PTnnn'` with the contracts code as the message (`PT403 forbidden`); profile checks
    ///   raise `23514` with `under_min_age` / `age_attestation_required` (docs/database.md "Conventions").
    static func from(supabase error: Error) -> AppError {
        if let appError = error as? AppError { return appError }

        if let functionsError = error as? FunctionsError {
            switch functionsError {
            case .httpError(let code, let data):
                return AppError.fromResponse(status: code, data: data)
            case .relayError:
                return .server(status: 502)
            }
        }

        if let postgrest = error as? PostgrestError {
            return from(postgrestCode: postgrest.code, message: postgrest.message)
        }

        if let authError = error as? AuthError {
            switch authError {
            case .sessionMissing:
                return .notSignedIn
            case .api(_, let errorCode, let data, let response):
                if response.statusCode == 401 || errorCode == .sessionNotFound || errorCode == .badJWT
                    || errorCode == .refreshTokenNotFound || errorCode == .refreshTokenAlreadyUsed {
                    return .notSignedIn
                }
                if errorCode == .overRequestRateLimit || errorCode == .overEmailSendRateLimit {
                    return .api(ApiError(code: ApiErrorCode.rateLimited.rawValue), status: 429)
                }
                // Keep GoTrue's own code (e.g. `otp_expired`, `email_exists`) so `messageKey` can map it.
                if !errorCode.rawValue.isEmpty, errorCode != .unknown {
                    return .api(ApiError(code: "auth.\(errorCode.rawValue)"), status: response.statusCode)
                }
                return AppError.fromResponse(status: response.statusCode, data: data)
            default:
                return .unknown(authError.message)
            }
        }

        if let storageError = error as? StorageError {
            let status = storageError.statusCode.flatMap(Int.init) ?? 400
            if status == 401 || status == 403 {
                return .api(ApiError(code: ApiErrorCode.forbidden.rawValue, message: storageError.message), status: status)
            }
            if status == 404 {
                return .api(ApiError(code: ApiErrorCode.notFound.rawValue, message: storageError.message), status: 404)
            }
            if status == 413 {
                return .api(ApiError(code: ApiErrorCode.payloadTooLarge.rawValue, message: storageError.message), status: 413)
            }
            return status >= 500 ? .server(status: status) : .unknown(storageError.message)
        }

        return AppError.from(error)
    }
}
