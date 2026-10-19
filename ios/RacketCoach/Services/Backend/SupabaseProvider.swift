import CoachCore
import Foundation
import Supabase

/// Owns the single `SupabaseClient` (supabase-swift 2.55.3), configured from the xcconfig hosts
/// (`AppConfiguration`). Every Edge Function call goes through `invoke`, which:
/// - pins the region `ap-southeast-1` on the hosted project (`FunctionsOptions.region`; none on the local stack);
/// - sends the current access token explicitly (the SDK updates the functions client asynchronously after a sign-in,
///   so a call right after `signInWithIdToken` could otherwise still carry the anonymous token);
/// - converts every failure into `AppError`.
final class SupabaseProvider: Sendable {
    let configuration: AppConfiguration
    /// Nil when the build has no usable backend configuration (`AppConfiguration.problems`).
    let client: SupabaseClient?

    init(configuration: AppConfiguration) {
        self.configuration = configuration
        guard configuration.isBackendConfigured, let url = configuration.supabaseURL else {
            client = nil
            return
        }
        let sessionConfiguration = URLSessionConfiguration.default
        sessionConfiguration.timeoutIntervalForRequest = 60
        sessionConfiguration.waitsForConnectivity = false
        let options = SupabaseClientOptions(
            db: SupabaseClientOptions.DatabaseOptions(),
            auth: SupabaseClientOptions.AuthOptions(emitLocalSessionAsInitialSession: true),
            global: SupabaseClientOptions.GlobalOptions(session: URLSession(configuration: sessionConfiguration)),
            functions: SupabaseClientOptions.FunctionsOptions(region: configuration.functionsRegion)
        )
        client = SupabaseClient(supabaseURL: url, supabaseKey: configuration.supabasePublishableKey, options: options)
    }

    func requireClient() throws -> SupabaseClient {
        guard let client else { throw AppError.notConfigured }
        return client
    }

    /// The signed-in user's lowercase id from the stored session (no network).
    var currentUserId: String? {
        guard let user = client?.auth.currentUser else { return nil }
        return IDs.lower(user.id)
    }

    /// A valid access token, refreshed by the SDK when it is about to expire.
    func accessToken() async throws -> String {
        let client = try requireClient()
        do {
            return try await client.auth.session.accessToken
        } catch {
            throw AppError.from(supabase: error)
        }
    }

    /// The signed-in user id, or `AppError.notSignedIn`.
    func requireUserId() throws -> String {
        guard let id = currentUserId else { throw AppError.notSignedIn }
        return id
    }

    // MARK: - Edge Functions

    /// POSTs `body` (already-encoded JSON) to `functions/v1/<name>` and decodes the 2xx answer.
    func invoke<Response: Decodable>(
        _ name: String,
        jsonBody: Data,
        accessToken explicitToken: String? = nil,
        as type: Response.Type = Response.self
    ) async throws -> Response {
        let data = try await invokeRaw(name, method: .post, jsonBody: jsonBody, accessToken: explicitToken)
        return try decode(Response.self, from: data, function: name)
    }

    /// POSTs an `Encodable` body encoded as JSON (keys as declared, no key strategy).
    func invoke<Body: Encodable, Response: Decodable>(
        _ name: String,
        body: Body,
        accessToken explicitToken: String? = nil,
        as type: Response.Type = Response.self
    ) async throws -> Response {
        let jsonBody = try encode(body, function: name)
        return try await invoke(name, jsonBody: jsonBody, accessToken: explicitToken, as: Response.self)
    }

    /// POSTs an `Encodable` body and ignores the 2xx answer (which may be empty).
    func invokeIgnoringResponse<Body: Encodable>(
        _ name: String,
        body: Body,
        accessToken explicitToken: String? = nil
    ) async throws {
        let jsonBody = try encode(body, function: name)
        _ = try await invokeRaw(name, method: .post, jsonBody: jsonBody, accessToken: explicitToken)
    }

    private func encode<Body: Encodable>(_ body: Body, function: String) throws -> Data {
        do {
            return try JSONEncoder().encode(body)
        } catch {
            throw AppError.unknown("encoding \(function) body: \(error)")
        }
    }

    /// GETs `functions/v1/<name>` and decodes the 2xx answer.
    func invokeGet<Response: Decodable>(_ name: String, as type: Response.Type = Response.self) async throws -> Response {
        let data = try await invokeRaw(name, method: .get, jsonBody: nil, accessToken: nil)
        return try decode(Response.self, from: data, function: name)
    }

    private func invokeRaw(
        _ name: String,
        method: FunctionInvokeOptions.Method,
        jsonBody: Data?,
        accessToken explicitToken: String?
    ) async throws -> Data {
        let client = try requireClient()
        let token: String
        if let explicitToken {
            token = explicitToken
        } else {
            token = try await accessToken()
        }
        var headers = ["Authorization": "Bearer \(token)"]
        let options: FunctionInvokeOptions
        if let jsonBody {
            headers["Content-Type"] = "application/json"
            options = FunctionInvokeOptions(method: method, headers: headers, region: configuration.functionsRegion, body: jsonBody)
        } else {
            options = FunctionInvokeOptions(method: method, headers: headers, region: configuration.functionsRegion)
        }
        do {
            return try await client.functions.invoke(name, options: options) { data, _ in data }
        } catch {
            throw AppError.from(supabase: error)
        }
    }

    private func decode<Response: Decodable>(_ type: Response.Type, from data: Data, function: String) throws -> Response {
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw AppError.decoding("\(function): \(error)")
        }
    }

    // MARK: - PostgREST

    /// Runs a PostgREST call and converts its errors.
    @discardableResult
    func database<T>(_ operation: (SupabaseClient) async throws -> T) async throws -> T {
        let client = try requireClient()
        do {
            return try await operation(client)
        } catch {
            throw AppError.from(supabase: error)
        }
    }
}
