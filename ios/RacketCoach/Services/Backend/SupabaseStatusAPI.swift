import CoachCore
import Foundation
import Supabase

/// `StatusAPI` and `ProfileAPI` on PostgREST.
struct SupabaseStatusAPI: StatusAPI, ProfileAPI {
    let provider: SupabaseProvider

    static let profileColumns =
        "id,locale,handedness,level,birth_year,age_attested,pdpl_consent_version,pdpl_consent_at,ai_consent_version,"
        + "ai_consent_at,calibration_opt_in,consumption_consent,is_reviewer"

    func myStatus() async throws -> MyStatus {
        try await provider.database { client in
            let response: PostgrestResponse<MyStatus> = try await client.rpc("my_status").execute()
            return response.value
        }
    }

    func appConfig() async throws -> AppConfigValues {
        try await provider.database { client in
            let response: PostgrestResponse<[AppConfigRow]> = try await client.from("app_config")
                .select("key,value")
                .execute()
            return AppConfigValues(rows: response.value)
        }
    }

    func profile() async throws -> Profile {
        let userId = try provider.requireUserId()
        return try await provider.database { client in
            let response: PostgrestResponse<Profile> = try await client.from("profiles")
                .select(Self.profileColumns)
                .eq("id", value: userId)
                .single()
                .execute()
            return response.value
        }
    }

    func update(_ patch: ProfilePatch) async throws -> Profile {
        guard !patch.isEmpty else { return try await profile() }
        let userId = try provider.requireUserId()
        return try await provider.database { client in
            let response: PostgrestResponse<Profile> = try await client.from("profiles")
                .update(patch, returning: .representation)
                .eq("id", value: userId)
                .select(Self.profileColumns)
                .single()
                .execute()
            return response.value
        }
    }
}

/// `AccountAPI` on Edge Functions.
struct SupabaseAccountAPI: AccountAPI {
    let provider: SupabaseProvider

    func appleAuthExchange(authorizationCode: String) async throws {
        try await provider.invokeIgnoringResponse(
            "apple-auth-exchange",
            body: AppleAuthExchangeRequest(authorizationCode: authorizationCode)
        )
    }

    func mergeAnonymousAccount(anonAccessToken: String) async throws -> AccountMergeResponse {
        try await provider.invoke(
            "account-merge",
            body: AccountMergeRequest(anonAccessToken: anonAccessToken),
            as: AccountMergeResponse.self
        )
    }

    func deleteAccount() async throws -> DeleteAccountResponse {
        try await provider.invoke("delete-account", body: DeleteAccountRequest(), as: DeleteAccountResponse.self)
    }

    func verifySubscription(_ request: VerifySubscriptionRequest) async throws -> VerifySubscriptionResponse {
        try await provider.invoke("verify-subscription", body: request, as: VerifySubscriptionResponse.self)
    }
}
