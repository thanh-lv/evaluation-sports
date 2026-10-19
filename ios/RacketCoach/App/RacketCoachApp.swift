import SwiftUI

@main
struct RacketCoachApp: App {
    @State private var model: AppModel

    init() {
        // Unit tests run inside the app: never touch the network or the real Keychain session there.
        let isUnitTest = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        let deps: Dependencies = isUnitTest ? .preview() : .live()
        let preferences = isUnitTest ? AppPreferences.ephemeral() : AppPreferences()
        _model = State(initialValue: AppModel(deps: deps, preferences: preferences))
    }

    var body: some Scene {
        WindowGroup {
            AppSceneRoot(model: model)
        }
    }
}

/// Launch tasks and scene-phase handling around `RootView`.
private struct AppSceneRoot: View {
    let model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        RootView()
            .environment(model)
            .task { await model.start() }
            .task {
                // D15: Vietnamese by default when the App Store storefront is Vietnam.
                if await StorefrontLanguageDefault.refresh() {
                    await model.updateResolvedLanguage()
                }
                await StorefrontLanguageDefault.observe {
                    await model.updateResolvedLanguage()
                }
            }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:
                    model.updateResolvedLanguage()
                    Task { await model.sceneDidBecomeActive() }
                case .background:
                    Task { await model.sceneDidEnterBackground() }
                default:
                    break
                }
            }
    }
}
