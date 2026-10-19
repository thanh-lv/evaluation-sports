import CoachCore
import Foundation

/// Build-time configuration read from `Info.plist`, which gets the values from `ios/Config/*.xcconfig`.
///
/// The xcconfig files hold **hosts only** and never contain `//` (an xcconfig treats it as a comment and silently
/// truncates the value, DESIGN.md §4, §5.1). Every URL is built here in code.
struct AppConfiguration: Sendable, Equatable {
    enum Environment: String, Sendable {
        /// The local Supabase stack from `make dev` (scheme `RacketCoach-Local`, Debug configuration).
        case local
        /// The hosted project in ap-southeast-1 (scheme `RacketCoach`, Release configuration).
        case production
    }

    /// Info.plist keys (same names as the xcconfig variables).
    enum Key {
        static let supabaseHost = "SUPABASE_HOST"
        static let supabaseScheme = "SUPABASE_SCHEME"
        static let supabasePublishableKey = "SUPABASE_PUBLISHABLE_KEY"
        static let legalHost = "LEGAL_HOST"
        static let supportHost = "SUPPORT_HOST"
        static let subscriptionGroupId = "SUBSCRIPTION_GROUP_ID"
        static let environment = "RC_ENVIRONMENT"
    }

    /// Supabase region of the hosted project; every Edge Function call is pinned to it (DESIGN.md §3, §5.2).
    static let hostedRegion = "ap-southeast-1"

    var environment: Environment
    /// `host[:port]`, e.g. `abcd1234.supabase.co` or `192.168.1.20:54321`.
    var supabaseHost: String
    /// `https` for the hosted project, `http` for the local stack.
    var supabaseScheme: String
    var supabasePublishableKey: String
    var legalHost: String
    var supportHost: String
    var subscriptionGroupId: String

    var isLocal: Bool { environment == .local }

    /// `https://<host>` (or `http://` locally). Nil when the host is missing or still a placeholder.
    var supabaseURL: URL? {
        guard isUsableHost(supabaseHost) else { return nil }
        var components = URLComponents()
        components.scheme = supabaseScheme
        let parts = supabaseHost.split(separator: ":", maxSplits: 1).map(String.init)
        components.host = parts.first
        if parts.count == 2, let port = Int(parts[1]) { components.port = port }
        return components.url
    }

    /// Region passed to `functions.invoke`; nil for the local stack, which has no regions.
    var functionsRegion: String? { isLocal ? nil : AppConfiguration.hostedRegion }

    /// Problems that make the backend unusable (shown in Debug builds; the app still runs offline features).
    var problems: [String] {
        var result: [String] = []
        if supabaseURL == nil { result.append("SUPABASE_HOST is missing or a placeholder") }
        if supabasePublishableKey.isEmpty || supabasePublishableKey.contains("$(") {
            result.append("SUPABASE_PUBLISHABLE_KEY is missing")
        }
        if supabaseScheme != "https" && supabaseScheme != "http" { result.append("SUPABASE_SCHEME must be http or https") }
        if environment == .production && supabaseScheme != "https" { result.append("production must use https") }
        return result
    }

    var isBackendConfigured: Bool { problems.isEmpty }

    private func isUsableHost(_ host: String) -> Bool {
        !host.isEmpty && !host.contains("$(") && !host.contains("YOUR_") && !host.contains("/")
    }

    /// Reads the values from an Info.plist dictionary (`Bundle.main.infoDictionary`).
    init(infoDictionary: [String: Any]) {
        func value(_ key: String) -> String {
            (infoDictionary[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        let scheme = value(Key.supabaseScheme).lowercased()
        supabaseScheme = scheme.isEmpty ? "https" : scheme
        environment = Environment(rawValue: value(Key.environment)) ?? (supabaseScheme == "http" ? .local : .production)
        supabaseHost = value(Key.supabaseHost)
        supabasePublishableKey = value(Key.supabasePublishableKey)
        legalHost = value(Key.legalHost)
        supportHost = value(Key.supportHost)
        subscriptionGroupId = value(Key.subscriptionGroupId)
    }

    init(
        environment: Environment,
        supabaseHost: String,
        supabaseScheme: String,
        supabasePublishableKey: String,
        legalHost: String,
        supportHost: String,
        subscriptionGroupId: String
    ) {
        self.environment = environment
        self.supabaseHost = supabaseHost
        self.supabaseScheme = supabaseScheme
        self.supabasePublishableKey = supabasePublishableKey
        self.legalHost = legalHost
        self.supportHost = supportHost
        self.subscriptionGroupId = subscriptionGroupId
    }

    /// The app's configuration from the main bundle.
    static var main: AppConfiguration {
        AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:])
    }

    /// Values for previews and tests (never contacts a server).
    static let preview = AppConfiguration(
        environment: .local,
        supabaseHost: "127.0.0.1:54321",
        supabaseScheme: "http",
        supabasePublishableKey: "preview",
        legalHost: "racketcoach.app",
        supportHost: "racketcoach.app",
        subscriptionGroupId: "00000000"
    )
}

/// Public web pages (docs/README.md "Published pages"): `https://{LEGAL_HOST}/{vi,en}/privacy` etc.
struct AppLinks: Sendable, Equatable {
    var legalHost: String
    var supportHost: String

    init(configuration: AppConfiguration) {
        legalHost = configuration.legalHost
        supportHost = configuration.supportHost
    }

    init(legalHost: String, supportHost: String) {
        self.legalHost = legalHost
        self.supportHost = supportHost
    }

    func privacyPolicy(_ language: Language) -> URL? { url(host: legalHost, path: "/\(language.rawValue)/privacy") }
    /// Terms of use (EULA).
    func terms(_ language: Language) -> URL? { url(host: legalHost, path: "/\(language.rawValue)/terms") }
    func aiDisclosure(_ language: Language) -> URL? { url(host: legalHost, path: "/\(language.rawValue)/ai") }
    func support(_ language: Language) -> URL? { url(host: supportHost, path: "/\(language.rawValue)/") }
    func cameraGuide(_ language: Language) -> URL? { url(host: supportHost, path: "/\(language.rawValue)/camera-guide") }

    private func url(host: String, path: String) -> URL? {
        guard !host.isEmpty, !host.contains("$(") else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.path = path
        return components.url
    }
}
