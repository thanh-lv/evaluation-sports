import SwiftUI
import CoachCore

/// Root routing (DESIGN.md §2.2): onboarding (Welcome → About you) until it is completed, then Home with a
/// `NavigationStack` driven by `AppModel.path`. Applies the in-app language to the whole tree
/// (`.environment(\.locale)` + `.id(language)`), hosts the root sheets and the consent sheet, and receives videos
/// opened from other apps.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if model.onboarding.completed {
                NavigationStack(path: $model.path) {
                    HomeView()
                        .navigationDestination(for: AppRoute.self) { route in
                            AppRouteDestination(route: route)
                        }
                }
            } else {
                OnboardingFlow()
            }
        }
        .sheet(item: $model.sheet) { sheet in
            AppSheetView(sheet: sheet)
                .environment(model)
                .environment(\.locale, model.resolvedLanguage.locale)
        }
        .consentHost()
        .tint(Color.rcAccent)
        .environment(\.locale, model.resolvedLanguage.locale)
        .id(model.resolvedLanguage)
        .onOpenURL { url in
            model.handleOpenURL(url)
        }
    }
}

#Preview("Home") {
    RootView()
        .environment(AppModel.preview())
}

#Preview("Onboarding") {
    RootView()
        .environment(AppModel.preview(onboarded: false))
}

extension AppModel {
    /// A model on mock services for SwiftUI previews.
    static func preview(tier: Tier = .free, remaining: Int = 1, onboarded: Bool = true) -> AppModel {
        let preferences = AppPreferences.ephemeral()
        if onboarded {
            preferences.onboarding = OnboardingState(completed: true, birthYear: 1995, ageAttested: false, handedness: .right, level: nil)
        }
        let model = AppModel(deps: .preview(tier: tier, remaining: remaining), preferences: preferences)
        Task { await model.start() }
        return model
    }
}
