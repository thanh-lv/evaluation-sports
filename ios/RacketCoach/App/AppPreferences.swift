import CoachCore
import Foundation

/// Small per-device settings in `UserDefaults` (PrivacyInfo reason `CA92.1`: app-only settings). Wraps a defaults
/// suite so tests and previews can use an isolated one.
final class AppPreferences: @unchecked Sendable {
    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// A throwaway suite for tests and previews.
    static func ephemeral(name: String = "racketcoach.preview.\(UUID().uuidString)") -> AppPreferences {
        let defaults = UserDefaults(suiteName: name) ?? .standard
        defaults.removePersistentDomain(forName: name)
        return AppPreferences(defaults: defaults)
    }

    enum Key {
        static let onboarding = "app.onboarding"
        static let profileSynced = "app.onboarding.profileSynced"
        static let cameraGuideSeen = "app.cameraGuideSeen."
        static let lastCleanupNoticeCount = "app.cleanup.lastCount"
    }

    var language: AppLanguage {
        get { AppLanguage.stored(in: defaults) }
        set { AppLanguage.store(newValue, in: defaults) }
    }

    var storefrontCountry: String? {
        defaults.string(forKey: AppLanguage.storefrontCountryKey)
    }

    var onboarding: OnboardingState {
        get {
            guard let data = defaults.data(forKey: Key.onboarding),
                  let state = try? JSONDecoder().decode(OnboardingState.self, from: data) else { return OnboardingState() }
            return state
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) { defaults.set(data, forKey: Key.onboarding) }
        }
    }

    /// The About-you answers reached the server profile.
    var profileSynced: Bool {
        get { defaults.bool(forKey: Key.profileSynced) }
        set { defaults.set(newValue, forKey: Key.profileSynced) }
    }

    /// The camera guide is shown automatically the first time per sport (DESIGN.md §2.2 step 4.2).
    func hasSeenCameraGuide(for sport: Sport) -> Bool {
        defaults.bool(forKey: Key.cameraGuideSeen + sport.rawValue)
    }

    func markCameraGuideSeen(for sport: Sport) {
        defaults.set(true, forKey: Key.cameraGuideSeen + sport.rawValue)
    }

    /// Removes every key this app wrote (account deletion, sign-out of a merged account).
    func resetAll() {
        for key in [Key.onboarding, Key.profileSynced, Key.lastCleanupNoticeCount, AppLanguage.storageKey] {
            defaults.removeObject(forKey: key)
        }
        for sport in Sport.allCases {
            defaults.removeObject(forKey: Key.cameraGuideSeen + sport.rawValue)
        }
    }
}

/// Answers from Welcome and About you, kept on the device until the server profile has them.
struct OnboardingState: Codable, Sendable, Equatable {
    var completed: Bool = false
    var birthYear: Int?
    var ageAttested: Bool = false
    var handedness: Handedness?
    var level: Level?

    /// The profile columns these answers fill (`ProfileAPI.update`).
    var profilePatch: ProfilePatch {
        ProfilePatch(
            handedness: handedness.map { .some($0) },
            level: level.map { .some($0) },
            birthYear: birthYear.map { .some($0) },
            ageAttested: birthYear == nil ? nil : ageAttested
        )
    }
}
