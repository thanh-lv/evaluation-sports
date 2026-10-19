import CoachCore
import Foundation
import Observation

/// App-wide state (DESIGN.md §5.2 App): session, profile, `my_status()`, catalog, app configuration, language,
/// onboarding gate, navigation and the just-in-time consent. Lives in the SwiftUI environment:
/// `@Environment(AppModel.self) private var model`.
///
/// Foundation + Observation only (no SwiftUI), so it is unit-testable with `Dependencies.preview()`.
@Observable
@MainActor
final class AppModel {
    enum AuthState: Equatable, Sendable {
        case unknown
        case signingIn
        case signedIn(AuthUser)
        /// The last attempt failed; the app retries when the network comes back (or after a back-off).
        case failed(AppError)
    }

    /// The consent sheet's input (DESIGN.md §2.2 step 5).
    struct ConsentRequest: Identifiable, Equatable, Sendable {
        let id = UUID()
        /// The user accepted an earlier version: show "We've updated how we handle your data".
        var isReconsent: Bool
        var pdplVersion: String
        var aiVersion: String
        /// Current values of the optional items (pre-filled only from an earlier explicit choice).
        var calibrationOptIn: Bool
        var consumptionConsent: Bool
    }

    enum ConsentOutcome: Equatable, Sendable {
        case accepted
        /// "Not now": the analysis must not be submitted.
        case declined
        /// The consent state could not be read or written (offline, server error).
        case failed(AppError)
    }

    /// Whether a new analysis may start right now (from `my_status()`; the server enforces it again).
    enum StartGate: Equatable, Sendable {
        case allowed
        /// Free tier with no analysis left: open the paywall.
        case paywall
        /// Trial or premium at the cap: "Lượt mới vào <date>" (or "Gói năm bắt đầu <date>" at the end of a trial).
        case waitUntil(Date?, trialEnded: Bool)
        /// Another analysis is still being processed (in-flight limit 1).
        case inFlight
    }

    // MARK: Dependencies

    let deps: Dependencies
    let preferences: AppPreferences

    // MARK: State

    private(set) var authState: AuthState = .unknown
    private(set) var profile: Profile?
    private(set) var status: MyStatus?
    private(set) var statusError: AppError?
    private(set) var catalog: CatalogResponseV1?
    private(set) var catalogError: AppError?
    private(set) var appConfig: AppConfigValues = .fallback
    /// Newest analysis with a cached result on this iPhone (Home "last result" card).
    private(set) var latestLocalResult: LocalAnalysisRecord?

    /// The in-app language choice (System / Tiếng Việt / English).
    private(set) var language: AppLanguage
    /// What the UI shows now; the root view sets `.environment(\.locale)` and `.id()` from it.
    private(set) var resolvedLanguage: Language

    private(set) var onboarding: OnboardingState

    /// Root navigation path (Home is the root).
    var path: [AppRoute] = []
    var sheet: AppSheet?
    var banner: AppBanner?
    /// A video opened from another app ("Open in RacketCoach"); the capture flow copies it and sets this to nil.
    var incomingVideoURL: URL?

    /// Non-nil while the consent sheet is shown.
    private(set) var consentRequest: ConsentRequest?
    /// Views that can present the consent sheet (`.consentHost()`); the last one presents it, so a flow shown in a
    /// full-screen cover can host the sheet above itself.
    private(set) var consentHosts: [UUID] = []
    @ObservationIgnored private var consentWaiters: [CheckedContinuation<ConsentOutcome, Never>] = []

    @ObservationIgnored private var started = false
    @ObservationIgnored private var authTask: Task<Void, Never>?
    @ObservationIgnored private var listenerTasks: [Task<Void, Never>] = []

    init(deps: Dependencies, preferences: AppPreferences = AppPreferences()) {
        self.deps = deps
        self.preferences = preferences
        let language = preferences.language
        self.language = language
        self.resolvedLanguage = AppModel.resolve(language, preferences: preferences)
        self.onboarding = preferences.onboarding
        L10n.setCurrentLanguage(resolvedLanguage)
    }

    // MARK: Derived

    var user: AuthUser? {
        if case .signedIn(let user) = authState { return user }
        return nil
    }

    var isSignedIn: Bool { user != nil }
    var isAnonymous: Bool { user?.isAnonymous ?? true }
    var tier: Tier { status?.tier ?? .free }
    var isPaid: Bool { status?.isPaid ?? false }
    var skills: [CatalogSkill] { catalog?.skills ?? [] }

    func skill(id: String) -> CatalogSkill? {
        catalog?.skills.first { $0.id == id }
    }

    /// Skill name in the UI language; the id when the catalog has not loaded.
    func skillName(id: String) -> String {
        skill(id: id)?.name.text(for: resolvedLanguage) ?? id
    }

    // MARK: Launch

    /// Starts sign-in, data loading, listeners and the 60-day video clean-up. Idempotent.
    func start() async {
        guard !started else { return }
        started = true
        deps.events.log(.appOpen)
        startAuthLoop()
        listenForUserChanges()
        listenForNetwork()
        await refreshLatestLocalResult()
        await cleanUpOldVideos()
    }

    /// Scene became active: refresh the quota (it may have reset) and resume what waits for the network.
    func sceneDidBecomeActive() async {
        guard started else { return }
        if isSignedIn {
            await refreshStatus()
        } else if case .failed = authState {
            startAuthLoop()
        }
        await refreshLatestLocalResult()
    }

    func sceneDidEnterBackground() async {
        await deps.events.flush()
    }

    // MARK: Auth

    private func startAuthLoop() {
        authTask?.cancel()
        authTask = Task { [weak self] in
            await self?.runAuthLoop()
        }
    }

    private func runAuthLoop() async {
        var failures = 0
        while !Task.isCancelled {
            if case .signedIn = authState { return }
            authState = .signingIn
            do {
                let user = try await deps.auth.signInAnonymouslyIfNeeded()
                // The user-change listener may have handled this sign-in already.
                if user != self.user { await didSignIn(user) }
                return
            } catch {
                let appError = AppError.from(error)
                authState = .failed(appError)
                if appError == .notConfigured || appError == .cancelled { return }
                failures += 1
                await waitBeforeRetry(failures: failures)
            }
        }
    }

    /// Waits for the back-off delay or for the network to come back (offline → online), whichever comes first.
    private func waitBeforeRetry(failures: Int) async {
        let delay = AuthRetryPolicy.delay(afterFailures: failures)
        let clock = deps.clock
        let network = deps.network
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                try? await clock.sleep(for: delay)
            }
            group.addTask {
                var sawOffline = false
                for await online in network.changes() {
                    if !online {
                        sawOffline = true
                    } else if sawOffline {
                        return
                    }
                }
            }
            await group.next()
            group.cancelAll()
        }
    }

    private func didSignIn(_ user: AuthUser) async {
        let previous = self.user
        authState = .signedIn(user)
        if previous?.id != user.id {
            profile = nil
            status = nil
        }
        await refreshAll()
        await syncOnboardingProfileIfNeeded()
    }

    private func listenForUserChanges() {
        let auth = deps.auth
        let task = Task { [weak self] in
            for await user in auth.userChanges() {
                guard let self else { return }
                await self.handleUserChange(user)
            }
        }
        listenerTasks.append(task)
    }

    private func handleUserChange(_ newUser: AuthUser?) async {
        guard let newUser else {
            // Signed out (or the account was deleted): start over with a fresh anonymous account.
            if case .signedIn = authState {
                authState = .unknown
                profile = nil
                status = nil
                startAuthLoop()
            }
            return
        }
        if newUser != user {
            await didSignIn(newUser)
        }
    }

    private func listenForNetwork() {
        let network = deps.network
        let task = Task { [weak self] in
            for await online in network.changes() where online {
                guard let self else { return }
                await self.networkBecameAvailable()
            }
        }
        listenerTasks.append(task)
    }

    private func networkBecameAvailable() async {
        switch authState {
        case .failed, .unknown:
            startAuthLoop()
        case .signedIn:
            if status == nil || catalog == nil { await refreshAll() }
            await deps.events.flush()
        case .signingIn:
            break
        }
    }

    /// Account linked, merged or signed out elsewhere in the app: reload everything for the current user.
    func accountDidChange() async {
        if let user = await deps.auth.currentUser() {
            await didSignIn(user)
        } else {
            authState = .unknown
            startAuthLoop()
        }
    }

    // MARK: Data

    func refreshAll() async {
        async let config: Void = refreshAppConfig()
        async let status: Void = refreshStatus()
        async let catalog: Void = refreshCatalog()
        async let profile: Void = refreshProfile()
        _ = await (config, status, catalog, profile)
    }

    func refreshStatus() async {
        guard isSignedIn else { return }
        do {
            status = try await deps.status.myStatus()
            statusError = nil
        } catch {
            statusError = AppError.from(error)
        }
    }

    func refreshCatalog() async {
        do {
            catalog = try await deps.analysis.catalog()
            catalogError = nil
        } catch {
            catalogError = AppError.from(error)
        }
    }

    func refreshAppConfig() async {
        if let values = try? await deps.status.appConfig() {
            appConfig = values
        }
    }

    func refreshProfile() async {
        guard isSignedIn else { return }
        if let value = try? await deps.profile.profile() {
            profile = value
        }
    }

    func refreshLatestLocalResult() async {
        latestLocalResult = await deps.localStore.latestWithResult()
    }

    /// Writes a profile change and keeps `profile` and `status` (consent block) current.
    @discardableResult
    func updateProfile(_ patch: ProfilePatch) async throws -> Profile {
        let updated = try await deps.profile.update(patch)
        profile = updated
        return updated
    }

    private func cleanUpOldVideos() async {
        let removed = await deps.storageMaintenance.removeExpiredVideos()
        guard removed > 0 else { return }
        banner = AppBanner(message: L10n.format("home.banner.videos_cleaned", removed, StorageMaintenance.maxVideoAgeDays))
        deps.events.log(.localVideosDeleted, props: ["count": .int(removed), "reason": "auto_60d"])
        await refreshLatestLocalResult()
    }

    // MARK: Language

    func setLanguage(_ newValue: AppLanguage) {
        guard newValue != language else { return }
        language = newValue
        preferences.language = newValue
        updateResolvedLanguage()
        deps.events.log(.languageChanged, props: ["language": .string(newValue.rawValue)])
        guard isSignedIn else { return }
        let patch = ProfilePatch(locale: .some(newValue.profileLocale))
        Task { [weak self] in
            _ = try? await self?.updateProfile(patch)
        }
    }

    /// Re-resolves `system` (call after the storefront country or the device region changed).
    func updateResolvedLanguage() {
        let resolved = AppModel.resolve(language, preferences: preferences)
        L10n.setCurrentLanguage(resolved)
        if resolved != resolvedLanguage { resolvedLanguage = resolved }
    }

    static func resolve(_ language: AppLanguage, preferences: AppPreferences) -> Language {
        language.resolved(
            storefrontCountry: preferences.storefrontCountry,
            regionCode: Locale.current.region?.identifier,
            preferredLanguages: Locale.preferredLanguages
        )
    }

    // MARK: Onboarding

    func beginOnboarding() {
        deps.events.log(.onboardingStarted)
    }

    /// Saves the About-you answers and opens Home. The profile is written now when signed in, otherwise after the
    /// anonymous sign-in succeeds.
    func completeOnboarding(birthYear: Int, ageAttested: Bool, handedness: Handedness, level: Level?) async {
        var state = onboarding
        state.birthYear = birthYear
        state.ageAttested = ageAttested
        state.handedness = handedness
        state.level = level
        state.completed = true
        onboarding = state
        preferences.onboarding = state
        preferences.profileSynced = false
        deps.events.log(.onboardingCompleted, props: ["hasLevel": .bool(level != nil)])
        if incomingVideoURL != nil { navigate(to: .newAnalysis(skillId: nil)) }
        await syncOnboardingProfileIfNeeded()
    }

    private func syncOnboardingProfileIfNeeded() async {
        guard onboarding.completed, !preferences.profileSynced, isSignedIn else { return }
        do {
            try await updateProfile(onboarding.profilePatch)
            preferences.profileSynced = true
        } catch let error as AppError where AppError.profileCheckCodes.contains(error.codeString ?? "") {
            // The minimum age changed on the server: ask again.
            var state = onboarding
            state.completed = false
            state.birthYear = nil
            state.ageAttested = false
            onboarding = state
            preferences.onboarding = state
            banner = AppBanner(message: error.localizedMessage, tone: .warning)
        } catch {
            // Offline or server trouble: retried on the next sign-in or launch.
        }
    }

    // MARK: Navigation

    func navigate(to route: AppRoute) {
        path.append(route)
    }

    func popToHome() {
        path.removeAll()
    }

    func presentPaywall(_ trigger: PaywallTrigger) {
        deps.events.log(.paywallViewed, props: ["trigger": .string(trigger.rawValue)])
        sheet = .paywall(trigger)
    }

    func analysisStartGate() -> StartGate {
        guard let status else { return .allowed }
        if status.inFlight >= max(status.limits.inFlight, 1) { return .inFlight }
        guard status.remaining <= 0 else { return .allowed }
        switch status.tier {
        case .free:
            return .paywall
        case .trial:
            let trialEnd = L10nFormat.parseISO8601(status.entitlement.expiresAt)
            return .waitUntil(trialEnd, trialEnded: true)
        case .premium:
            return .waitUntil(status.resetsAtDate, trialEnded: false)
        }
    }

    /// Home's "Analyze a stroke": opens the flow, the paywall, or explains when the next analysis is available.
    func startNewAnalysis(skillId: String? = nil) {
        switch analysisStartGate() {
        case .allowed:
            deps.events.log(.analysisStarted)
            navigate(to: .newAnalysis(skillId: skillId))
        case .paywall:
            presentPaywall(.quotaExhausted)
        case .waitUntil(let date, let trialEnded):
            let key = trialEnded ? "home.quota.trial_ended_on" : "home.quota.next_on"
            let dateText = date.map { L10nFormat.shortDayMonth($0, language: resolvedLanguage) } ?? "—"
            banner = AppBanner(message: L10n.format(key, dateText), tone: .info)
        case .inFlight:
            banner = AppBanner(message: L10n.string("home.quota.in_flight"), tone: .info)
        }
    }

    /// "Open in RacketCoach" from the share sheet or Files (`CFBundleDocumentTypes`).
    func handleOpenURL(_ url: URL) {
        guard url.isFileURL else { return }
        incomingVideoURL = url
        guard onboarding.completed else { return }
        if !path.contains(where: { if case .newAnalysis = $0 { return true } else { return false } }) {
            navigate(to: .newAnalysis(skillId: nil))
        }
    }

    // MARK: Consent (DESIGN.md §2.2 step 5, §11)

    /// Call right before the first submit. Returns at once when both required consents are current; otherwise shows
    /// the consent sheet and waits for the user's answer. Never submit unless this returns `.accepted`.
    func ensureConsent() async -> ConsentOutcome {
        if status == nil { await refreshStatus() }
        guard let status else { return .failed(statusError ?? .offline) }
        if status.consent.upToDate { return .accepted }
        guard let pdpl = status.consent.pdpl.current ?? appConfig.consentVersions?.pdpl,
              let ai = status.consent.ai.current ?? appConfig.consentVersions?.ai else {
            return .failed(statusError ?? .offline)
        }
        if consentRequest == nil {
            consentRequest = ConsentRequest(
                isReconsent: status.consent.isReconsent,
                pdplVersion: pdpl,
                aiVersion: ai,
                calibrationOptIn: profile?.calibrationOptIn ?? false,
                consumptionConsent: profile?.consumptionConsent ?? false
            )
            deps.events.log(.consentShown, props: ["reconsent": .bool(status.consent.isReconsent)])
        }
        return await withCheckedContinuation { continuation in
            consentWaiters.append(continuation)
        }
    }

    /// "Agree and continue": stores (a) and (b) at the shown versions plus the optional (c) and (d). Throws so the
    /// sheet can show the error and stay open.
    func acceptConsent(calibrationOptIn: Bool, consumptionConsent: Bool) async throws {
        guard let request = consentRequest else { return }
        let patch = ProfilePatch(
            pdplConsentVersion: .some(request.pdplVersion),
            aiConsentVersion: .some(request.aiVersion),
            calibrationOptIn: calibrationOptIn,
            consumptionConsent: consumptionConsent
        )
        try await updateProfile(patch)
        await refreshStatus()
        deps.events.log(.consentAccepted, props: [
            "calibration": .bool(calibrationOptIn),
            "consumption": .bool(consumptionConsent),
        ])
        finishConsent(.accepted)
    }

    /// "Not now".
    func declineConsent() {
        finishConsent(.declined)
    }

    /// Settings › Privacy › "Withdraw consent": clears (a) and (b); new analyses need consent again.
    func withdrawConsent() async throws {
        try await updateProfile(ProfilePatch(pdplConsentVersion: .some(nil), aiConsentVersion: .some(nil)))
        await refreshStatus()
        deps.events.log(.consentWithdrawn)
    }

    func registerConsentHost(_ id: UUID) {
        consentHosts.removeAll { $0 == id }
        consentHosts.append(id)
    }

    func unregisterConsentHost(_ id: UUID) {
        consentHosts.removeAll { $0 == id }
    }

    private func finishConsent(_ outcome: ConsentOutcome) {
        consentRequest = nil
        let waiters = consentWaiters
        consentWaiters.removeAll()
        for waiter in waiters { waiter.resume(returning: outcome) }
    }
}
