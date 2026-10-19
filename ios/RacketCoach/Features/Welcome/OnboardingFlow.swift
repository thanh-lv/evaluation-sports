import SwiftUI

/// Welcome → About you (DESIGN.md §2.2 steps 1–2). The sample analysis is reachable before onboarding (offline demo,
/// App Review). Finishing About you sets `AppModel.onboarding.completed`, and `RootView` switches to Home.
struct OnboardingFlow: View {
    enum Step: Hashable {
        case aboutYou
        case sample
    }

    @Environment(AppModel.self) private var model
    @State private var path: [Step] = []

    var body: some View {
        NavigationStack(path: $path) {
            WelcomeView(
                onStart: {
                    model.beginOnboarding()
                    path.append(.aboutYou)
                },
                onSample: {
                    path.append(.sample)
                }
            )
            .navigationDestination(for: Step.self) { step in
                switch step {
                case .aboutYou:
                    AboutYouView()
                case .sample:
                    AppRouteDestination(route: .sampleAnalysis)
                }
            }
        }
    }
}
