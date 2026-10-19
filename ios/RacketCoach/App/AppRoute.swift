import CoachCore
import Foundation

/// Screens pushed on the root `NavigationStack` (`AppModel.path`). Feature screens are wired in
/// `AppRouteDestinations.swift`. Push with `model.navigate(to:)`.
enum AppRoute: Hashable, Sendable {
    /// New analysis flow (skill grid → camera guide → source → … → results). Pushed, not presented modally, so the
    /// consent sheet and the paywall can be presented from the root.
    case newAnalysis(skillId: String?)
    /// Camera guide (§10.3); nil shows both sports.
    case cameraGuide(sport: Sport?)
    /// Offline sample analysis (Demo, no network, no quota).
    case sampleAnalysis
    /// A finished (or still running) analysis.
    case result(analysisId: String)
    case history
    case progress
    case settings
}

/// Sheets presented from the root (`AppModel.sheet`).
enum AppSheet: Identifiable, Hashable, Sendable {
    case paywall(PaywallTrigger)
    /// "Lưu lịch sử & dùng trên thiết bị khác": Sign in with Apple or email OTP (`AccountLinking`).
    case accountLink
    case languagePicker

    var id: String {
        switch self {
        case .paywall(let trigger): return "paywall.\(trigger.rawValue)"
        case .accountLink: return "accountLink"
        case .languagePicker: return "languagePicker"
        }
    }
}

/// Why the paywall opened (DESIGN.md §2.2 step 11); also the `paywall_viewed` event prop.
enum PaywallTrigger: String, Hashable, Sendable, CaseIterable {
    case quotaExhausted = "quota_exhausted"
    case lockedSection = "locked_section"
    case progress
    case player
    case history
    case settings
    case home
}

/// A short message at the top of Home (auto-cleaned videos, errors that need no decision).
struct AppBanner: Identifiable, Hashable, Sendable {
    enum Tone: Hashable, Sendable {
        case info
        case warning
        case error
    }

    let id: UUID
    var message: String
    var tone: Tone

    init(message: String, tone: Tone = .info) {
        id = UUID()
        self.message = message
        self.tone = tone
    }
}
