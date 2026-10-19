import CoachCore
import Foundation
import Supabase

/// `AccountLinking` on supabase-swift (DESIGN.md §5.2 Auth, D14).
///
/// - Apple: `linkIdentityWithIdToken(.apple, idToken, rawNonce)`, then `/apple-auth-exchange` with the authorization
///   code (refresh token for revocation on deletion).
/// - Email: `update(user: email)` sends a 6-digit code; `verifyOTP(type: .emailChange)` confirms it.
/// - Identity already exists: keep the anonymous access token, sign in to the existing account
///   (`signInWithIdToken` / `verifyOTP(.email)`), then `POST /account-merge {anonAccessToken}` with the new JWT.
struct SupabaseAccountLinker: AccountLinking {
    let provider: SupabaseProvider
    let account: any AccountAPI

    func linkApple(_ credential: AppleCredential) async throws -> LinkOutcome {
        let client = try provider.requireClient()
        // Captured first: after a sign-in to an existing account this token is the only proof of the anonymous one.
        let anonToken = try await provider.accessToken()
        let oidc = OpenIDConnectCredentials(provider: .apple, idToken: credential.idToken, nonce: credential.rawNonce)
        do {
            let session = try await client.auth.linkIdentityWithIdToken(credentials: oidc)
            await exchangeAppleCode(credential.authorizationCode)
            return .linked(AuthUser(supabase: session.user))
        } catch {
            let mapped = AppError.from(supabase: error)
            guard SupabaseAccountLinker.isIdentityTaken(mapped) else { throw mapped }
        }

        let session: Session
        do {
            session = try await client.auth.signInWithIdToken(credentials: oidc)
        } catch {
            throw AppError.from(supabase: error)
        }
        await exchangeAppleCode(credential.authorizationCode)
        try await merge(anonToken: anonToken, into: session)
        return .merged(AuthUser(supabase: session.user))
    }

    func startEmailLink(email: String) async throws -> EmailLinkStage {
        let client = try provider.requireClient()
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard SupabaseAccountLinker.isPlausibleEmail(address) else {
            throw AppError.api(ApiError(code: "auth.email_address_invalid"), status: 400)
        }
        do {
            _ = try await client.auth.update(user: UserAttributes(email: address))
            return .codeSentForLink
        } catch {
            let mapped = AppError.from(supabase: error)
            guard SupabaseAccountLinker.isIdentityTaken(mapped) else { throw mapped }
        }
        do {
            try await client.auth.signInWithOTP(email: address, shouldCreateUser: false)
            return .codeSentForExistingAccount
        } catch {
            throw AppError.from(supabase: error)
        }
    }

    func verifyEmailLink(email: String, code: String, stage: EmailLinkStage) async throws -> LinkOutcome {
        let client = try provider.requireClient()
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let token = code.filter(\.isNumber)
        switch stage {
        case .codeSentForLink:
            do {
                let response = try await client.auth.verifyOTP(email: address, token: token, type: .emailChange)
                let user = try await currentUser(fallback: response.user)
                return .linked(user)
            } catch {
                throw AppError.from(supabase: error)
            }
        case .codeSentForExistingAccount:
            let anonToken = try await provider.accessToken()
            let response: AuthResponse
            do {
                response = try await client.auth.verifyOTP(email: address, token: token, type: .email)
            } catch {
                throw AppError.from(supabase: error)
            }
            guard let session = response.session else { throw AppError.notSignedIn }
            try await merge(anonToken: anonToken, into: session)
            return .merged(AuthUser(supabase: session.user))
        }
    }

    // MARK: - Helpers

    /// GoTrue answers 422 `identity_already_exists` (link) or `email_exists` (update) when the identity has an account.
    static func isIdentityTaken(_ error: AppError) -> Bool {
        guard let code = error.codeString else { return false }
        return ["auth.identity_already_exists", "auth.email_exists", "auth.user_already_exists"].contains(code)
    }

    static func isPlausibleEmail(_ text: String) -> Bool {
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."), !text.contains(" ") else { return false }
        return !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
    }

    private func currentUser(fallback: User) async throws -> AuthUser {
        guard let client = provider.client else { return AuthUser(supabase: fallback) }
        if let user = try? await client.auth.session.user { return AuthUser(supabase: user) }
        return AuthUser(supabase: fallback)
    }

    /// Best effort: without the stored refresh token, account deletion tells the user to revoke Sign in with Apple
    /// in iOS Settings (`siwaManualRevoke`).
    private func exchangeAppleCode(_ code: String?) async {
        guard let code, !code.isEmpty else { return }
        try? await account.appleAuthExchange(authorizationCode: code)
    }

    /// Moves the anonymous account's analyses, counters and subscriptions into the signed-in account. Retries
    /// transient failures a few times: after the sign-in the anonymous token is the only handle on the old account.
    private func merge(anonToken: String, into session: Session) async throws {
        var attempt = 0
        while true {
            do {
                _ = try await account.mergeAnonymousAccount(anonAccessToken: anonToken)
                return
            } catch let error as AppError where error.isTransient && attempt < 3 {
                attempt += 1
                try await Task.sleep(for: AuthRetryPolicy.delay(afterFailures: attempt))
            }
        }
    }
}
