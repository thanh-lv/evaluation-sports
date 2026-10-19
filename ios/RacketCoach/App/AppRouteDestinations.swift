import CoachCore
import SwiftUI

// The one place where feature screens are attached to routes and root sheets.
//
// Ownership: each `case` belongs to the feature agent named in its comment. To wire a feature, replace only its
// placeholder line with the feature's root view (keep the comment). Everything else in this file stays with the
// App shell.

/// Screen for a pushed `AppRoute` (root `NavigationStack`).
struct AppRouteDestination: View {
    let route: AppRoute

    var body: some View {
        switch route {
        case .newAnalysis:
            // Capture/Pipeline: NewAnalysisFlowView(initialSkillId: skillId) — consumes model.incomingVideoURL.
            RCPlaceholderView(title: "route.new_analysis")
        case .cameraGuide:
            // Capture/Guide: CameraGuideView(sport: sport)
            RCPlaceholderView(title: "route.camera_guide")
        case .sampleAnalysis:
            // Demo: SampleAnalysisView()
            RCPlaceholderView(title: "route.sample_analysis")
        case .result:
            // Results: ResultScreen(analysisId: analysisId)
            RCPlaceholderView(title: "route.result")
        case .history:
            // History: HistoryView()
            RCPlaceholderView(title: "route.history")
        case .progress:
            // Progress: ProgressScreen()
            RCPlaceholderView(title: "route.progress")
        case .settings:
            // Settings: SettingsView()
            RCPlaceholderView(title: "route.settings")
        }
    }
}

/// Content of a root sheet (`AppModel.sheet`).
struct AppSheetView: View {
    let sheet: AppSheet

    var body: some View {
        switch sheet {
        case .paywall:
            // Paywall/Purchases: PaywallView(trigger: trigger)
            NavigationStack { RCPlaceholderView(title: "route.paywall") }
        case .accountLink:
            // Settings (account): AccountLinkView() — uses deps.linker (AccountLinking) and AppleSignIn.
            NavigationStack { RCPlaceholderView(title: "route.account_link") }
        case .languagePicker:
            LanguagePickerView()
        }
    }
}
