import CoachCore
import Foundation

/// The signed-in Supabase user as the app sees it. `id` is lowercase (`IDs.lower`), the form used for Storage paths,
/// `appAccountToken` and every RPC.
struct AuthUser: Sendable, Hashable, Codable {
    var id: String
    var isAnonymous: Bool
    /// Confirmed email (email OTP link, or the address Sign in with Apple shared).
    var email: String?
    /// Linked identity providers (`apple`, `email`); empty for an anonymous user.
    var providers: [String]

    init(id: String, isAnonymous: Bool, email: String? = nil, providers: [String] = []) {
        self.id = IDs.lower(id) ?? id.lowercased()
        self.isAnonymous = isAnonymous
        self.email = email
        self.providers = providers
    }

    var isLinkedWithApple: Bool { providers.contains("apple") }
    var appAccountToken: UUID? { UUID(uuidString: id) }
}

/// Session handling (DESIGN.md D14): an anonymous Supabase account is created silently at first launch and drives
/// quota, Storage paths, RLS and the StoreKit `appAccountToken`. Signing in is optional (`AccountLinking`).
protocol AuthService: Sendable {
    /// The stored session's user, without a network call (nil before the first sign-in or after sign-out).
    func currentUser() async -> AuthUser?
    /// Returns the stored user, or signs in anonymously (`auth.signInAnonymously()`). Throws `AppError.offline` and
    /// friends; `AnonAuthRunner` retries when the device comes back online.
    func signInAnonymouslyIfNeeded() async throws -> AuthUser
    /// A valid access token (refreshed when needed). Throws `AppError.notSignedIn` without a session.
    func accessToken() async throws -> String
    /// Every user change (sign-in, link, merge, sign-out → nil). The stream starts with the current value.
    func userChanges() -> AsyncStream<AuthUser?>
    /// Signs out locally and on the server. The app then creates a fresh anonymous account.
    func signOut() async throws
}

/// What Sign in with Apple hands back, ready for Supabase (`AppleSignIn.swift` builds it).
struct AppleCredential: Sendable, Hashable {
    /// The identity token (JWT) from `ASAuthorizationAppleIDCredential.identityToken`.
    var idToken: String
    /// The unhashed nonce; its SHA-256 hex went into the Apple request. Supabase hashes it again to compare.
    var rawNonce: String
    /// One-time authorization code for `apple-auth-exchange` (refresh token for revocation on deletion).
    var authorizationCode: String?
    /// Only present on the very first authorization of this Apple ID for the app.
    var email: String?
}

/// Result of linking the anonymous account to a permanent identity.
enum LinkOutcome: Sendable, Hashable {
    /// The identity was new: the anonymous account itself became permanent (same user id, history kept).
    case linked(AuthUser)
    /// The identity already had an account: the app signed in to it and the server merged the anonymous account's
    /// analyses, counters and subscriptions into it (`/account-merge`). The user id changed.
    case merged(AuthUser)

    var user: AuthUser {
        switch self {
        case .linked(let user), .merged(let user): return user
        }
    }
}

/// Where the email flow stands after `startEmailLink`.
enum EmailLinkStage: Sendable, Hashable {
    /// A 6-digit code was sent to confirm the address for this (anonymous) account.
    case codeSentForLink
    /// The address already belongs to an account: a sign-in code was sent; verifying it merges this account into it.
    case codeSentForExistingAccount
}

/// "Lưu lịch sử & dùng trên thiết bị khác" (DESIGN.md §5.2 Auth, D14). Implemented by `SupabaseAccountLinker`.
protocol AccountLinking: Sendable {
    /// Links Sign in with Apple (`linkIdentityWithIdToken(.apple)`, then `/apple-auth-exchange`). If the Apple ID
    /// already has an account, signs in to it and merges this anonymous account into it.
    func linkApple(_ credential: AppleCredential) async throws -> LinkOutcome
    /// Sends a one-time code to `email` (`updateUser(email:)`, or `signInWithOTP` when the address is taken).
    func startEmailLink(email: String) async throws -> EmailLinkStage
    /// Verifies the code from `startEmailLink` (`verifyOTP(.emailChange)` or `verifyOTP(.email)` + merge).
    func verifyEmailLink(email: String, code: String, stage: EmailLinkStage) async throws -> LinkOutcome
}

/// Pure retry schedule for the silent anonymous sign-in (2 s, 4 s, 8 s … capped at 60 s).
enum AuthRetryPolicy {
    static func delay(afterFailures failures: Int) -> Duration {
        let exponent = min(max(failures - 1, 0), 5)
        return min(.seconds(2 << exponent), .seconds(60))
    }
}
