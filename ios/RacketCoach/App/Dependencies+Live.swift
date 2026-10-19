import Foundation

extension Dependencies {
    /// The production graph: one `SupabaseProvider` from the xcconfig hosts (`AppConfiguration.main`).
    /// With an unusable configuration (e.g. a fresh clone without `Config/Local.xcconfig`) every backend call throws
    /// `AppError.notConfigured`; offline features (sample analysis, camera guide) still work.
    static func live(configuration: AppConfiguration = .main) -> Dependencies {
        let provider = SupabaseProvider(configuration: configuration)
        let account = SupabaseAccountAPI(provider: provider)
        let statusAPI = SupabaseStatusAPI(provider: provider)
        return Dependencies(
            configuration: configuration,
            auth: SupabaseAuthService(provider: provider),
            linker: SupabaseAccountLinker(provider: provider, account: account),
            analysis: SupabaseAnalysisAPI(provider: provider),
            status: statusAPI,
            profile: statusAPI,
            account: account,
            events: SupabaseEventLogger(provider: provider),
            localStore: FileLocalAnalysisStore(),
            clock: SystemClock(),
            deviceCheck: DeviceCheckService(),
            network: NetworkMonitor()
        )
    }
}
