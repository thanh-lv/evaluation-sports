import CoachCore
import Foundation
import Supabase

/// `AuthService` on supabase-swift (DESIGN.md D14): a silent anonymous account at first launch
/// (`auth.signInAnonymously()`), kept in the Keychain by the SDK and refreshed automatically.
struct SupabaseAuthService: AuthService {
    let provider: SupabaseProvider

    func currentUser() async -> AuthUser? {
        guard let user = provider.client?.auth.currentUser else { return nil }
        return AuthUser(supabase: user)
    }

    func signInAnonymouslyIfNeeded() async throws -> AuthUser {
        let client = try provider.requireClient()
        if let user = client.auth.currentUser {
            // A stored session: make sure it is still usable (refreshes an expired access token).
            do {
                let session = try await client.auth.session
                return AuthUser(supabase: session.user)
            } catch {
                let mapped = AppError.from(supabase: error)
                // Offline with a stored session: keep working with it; the SDK refreshes when back online.
                if mapped.isTransient { return AuthUser(supabase: user) }
                if mapped != .notSignedIn { throw mapped }
                // The refresh token was revoked (account deleted elsewhere): start over anonymously.
            }
        }
        do {
            let session = try await client.auth.signInAnonymously()
            return AuthUser(supabase: session.user)
        } catch {
            throw AppError.from(supabase: error)
        }
    }

    func accessToken() async throws -> String {
        try await provider.accessToken()
    }

    func userChanges() -> AsyncStream<AuthUser?> {
        guard let client = provider.client else {
            return AsyncStream { continuation in
                continuation.yield(nil)
                continuation.finish()
            }
        }
        return AsyncStream { continuation in
            let task = Task {
                for await change in client.auth.authStateChanges {
                    switch change.event {
                    case .initialSession, .signedIn, .signedOut, .userUpdated, .tokenRefreshed, .userDeleted:
                        continuation.yield(change.session.map { AuthUser(supabase: $0.user) })
                    default:
                        continue
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func signOut() async throws {
        let client = try provider.requireClient()
        do {
            try await client.auth.signOut(scope: .local)
        } catch {
            throw AppError.from(supabase: error)
        }
    }
}

extension AuthUser {
    init(supabase user: User) {
        let providers = (user.identities ?? []).map(\.provider).filter { $0 != "anonymous" }
        self.init(
            id: IDs.lower(user.id),
            isAnonymous: user.isAnonymous,
            email: user.email.flatMap { $0.isEmpty ? nil : $0 },
            providers: Array(Set(providers)).sorted()
        )
    }
}
