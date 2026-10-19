import Foundation

/// Every service the app uses, behind protocols (DESIGN.md §5.2 App), so previews and tests run on mocks.
/// Build the real graph with `Dependencies.live()` (Dependencies+Live.swift) and the offline one with
/// `Dependencies.preview()` (Mocks/MockServices.swift).
///
/// Features read it from `AppModel.deps` (the model is in the SwiftUI environment: `@Environment(AppModel.self)`).
struct Dependencies: Sendable {
    var configuration: AppConfiguration
    var auth: any AuthService
    var linker: any AccountLinking
    var analysis: any AnalysisAPI
    var status: any StatusAPI
    var profile: any ProfileAPI
    var account: any AccountAPI
    var events: any EventLogger
    var localStore: any LocalAnalysisStore
    var clock: any AppClock
    var deviceCheck: any DeviceCheckProviding
    var network: any NetworkMonitoring

    init(
        configuration: AppConfiguration,
        auth: any AuthService,
        linker: any AccountLinking,
        analysis: any AnalysisAPI,
        status: any StatusAPI,
        profile: any ProfileAPI,
        account: any AccountAPI,
        events: any EventLogger,
        localStore: any LocalAnalysisStore,
        clock: any AppClock,
        deviceCheck: any DeviceCheckProviding,
        network: any NetworkMonitoring
    ) {
        self.configuration = configuration
        self.auth = auth
        self.linker = linker
        self.analysis = analysis
        self.status = status
        self.profile = profile
        self.account = account
        self.events = events
        self.localStore = localStore
        self.clock = clock
        self.deviceCheck = deviceCheck
        self.network = network
    }

    /// Housekeeping for local videos (60-day clean-up, delete all, usage).
    var storageMaintenance: StorageMaintenance {
        StorageMaintenance(store: localStore, clock: clock)
    }

    /// Public web pages (privacy, terms, AI disclosure, support, camera guide).
    var links: AppLinks { AppLinks(configuration: configuration) }
}
