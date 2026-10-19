import CoachCore
import Foundation

// In-memory implementations of every service protocol for SwiftUI previews and unit tests. They never touch the
// network. Mutable state is guarded by a lock (`@unchecked Sendable`).

extension Dependencies {
    /// A complete offline graph. `local` defaults to a store in a fresh temporary folder.
    static func preview(
        tier: Tier = .free,
        remaining: Int = 1,
        onboarded: Bool = true,
        backend: MockBackend = MockBackend(),
        local: (any LocalAnalysisStore)? = nil,
        clock: any AppClock = ManualClock()
    ) -> Dependencies {
        backend.setStatus(.preview(tier: tier, remaining: remaining))
        let store = local ?? FileLocalAnalysisStore(
            root: FileManager.default.temporaryDirectory.appendingPathComponent("rc-preview-\(UUID().uuidString)")
        )
        return Dependencies(
            configuration: .preview,
            auth: MockAuthService(),
            linker: MockAccountLinker(),
            analysis: MockAnalysisAPI(backend: backend),
            status: backend,
            profile: backend,
            account: MockAccountAPI(),
            events: MockEventLogger(),
            localStore: store,
            clock: clock,
            deviceCheck: MockDeviceCheck(),
            network: MockNetworkMonitor()
        )
    }
}

/// Thread-safe box for mock state.
final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func get() -> Value {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ newValue: Value) {
        lock.lock()
        value = newValue
        lock.unlock()
    }

    @discardableResult
    func mutate<T>(_ body: (inout Value) throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body(&value)
    }
}

// MARK: - Auth

final class MockAuthService: AuthService, @unchecked Sendable {
    let user = Locked<AuthUser?>(nil)
    /// Number of `signInAnonymouslyIfNeeded` calls that fail with `.offline` before one succeeds.
    let failuresBeforeSuccess = Locked(0)
    let signInCalls = Locked(0)
    private let continuations = Locked<[UUID: AsyncStream<AuthUser?>.Continuation]>([:])

    init(user: AuthUser? = nil, failuresBeforeSuccess: Int = 0) {
        self.user.set(user)
        self.failuresBeforeSuccess.set(failuresBeforeSuccess)
    }

    func currentUser() async -> AuthUser? { user.get() }

    func signInAnonymouslyIfNeeded() async throws -> AuthUser {
        signInCalls.mutate { $0 += 1 }
        if let existing = user.get() { return existing }
        let shouldFail = failuresBeforeSuccess.mutate { remaining -> Bool in
            guard remaining > 0 else { return false }
            remaining -= 1
            return true
        }
        if shouldFail { throw AppError.offline }
        let created = AuthUser(id: IDs.newId(), isAnonymous: true)
        setUser(created)
        return created
    }

    func accessToken() async throws -> String {
        guard user.get() != nil else { throw AppError.notSignedIn }
        return "mock-access-token"
    }

    func userChanges() -> AsyncStream<AuthUser?> {
        AsyncStream { continuation in
            let id = UUID()
            continuations.mutate { $0[id] = continuation }
            continuation.yield(user.get())
            continuation.onTermination = { [weak self] _ in
                self?.continuations.mutate { $0[id] = nil }
            }
        }
    }

    func signOut() async throws {
        setUser(nil)
    }

    /// Replaces the user and notifies `userChanges` subscribers.
    func setUser(_ newUser: AuthUser?) {
        user.set(newUser)
        for continuation in continuations.get().values { continuation.yield(newUser) }
    }
}

final class MockAccountLinker: AccountLinking, @unchecked Sendable {
    let outcome = Locked<LinkOutcome?>(nil)

    func linkApple(_ credential: AppleCredential) async throws -> LinkOutcome {
        outcome.get() ?? .linked(AuthUser(id: IDs.newId(), isAnonymous: false, email: credential.email, providers: ["apple"]))
    }

    func startEmailLink(email: String) async throws -> EmailLinkStage { .codeSentForLink }

    func verifyEmailLink(email: String, code: String, stage: EmailLinkStage) async throws -> LinkOutcome {
        guard code.count == 6 else { throw AppError.api(ApiError(code: "auth.otp_expired"), status: 403) }
        return outcome.get() ?? .linked(AuthUser(id: IDs.newId(), isAnonymous: false, email: email, providers: ["email"]))
    }
}

// MARK: - Backend

/// Shared in-memory backend state for `StatusAPI`, `ProfileAPI` and `MockAnalysisAPI`.
final class MockBackend: StatusAPI, ProfileAPI, @unchecked Sendable {
    let status = Locked<MyStatus>(.preview())
    let profileRow = Locked<Profile>(Profile(id: "00000000-0000-4000-8000-000000000001"))
    let config = Locked<AppConfigValues>(
        AppConfigValues(minUserAge: 18, consentVersions: .init(pdpl: "2026-10-01", ai: "2026-10-01"))
    )
    /// When set, every call throws it (offline previews, error tests).
    let failure = Locked<AppError?>(nil)
    let profileUpdates = Locked<[ProfilePatch]>([])

    init() {}

    func setStatus(_ value: MyStatus) { status.set(value) }

    func myStatus() async throws -> MyStatus {
        if let failure = failure.get() { throw failure }
        return status.get()
    }

    func appConfig() async throws -> AppConfigValues {
        if let failure = failure.get() { throw failure }
        return config.get()
    }

    func profile() async throws -> Profile {
        if let failure = failure.get() { throw failure }
        return profileRow.get()
    }

    func update(_ patch: ProfilePatch) async throws -> Profile {
        if let failure = failure.get() { throw failure }
        profileUpdates.mutate { $0.append(patch) }
        let minAge = config.get().minUserAge
        let currentYear = Calendar(identifier: .gregorian).component(.year, from: Date())
        if case .some(.some(let year)) = patch.birthYear {
            switch AgeGate.evaluate(birthYear: year, currentYear: currentYear, minimumAge: minAge) {
            case .blocked: throw AppError.api(ApiError(code: "under_min_age"), status: 400)
            case .needsAttestation where patch.ageAttested != true:
                throw AppError.api(ApiError(code: "age_attestation_required"), status: 400)
            default: break
            }
        }
        let updated = profileRow.mutate { row -> Profile in
            if let value = patch.locale { row.locale = value }
            if let value = patch.handedness { row.handedness = value }
            if let value = patch.level { row.level = value }
            if let value = patch.birthYear { row.birthYear = value }
            if let value = patch.ageAttested { row.ageAttested = value }
            if let value = patch.pdplConsentVersion { row.pdplConsentVersion = value }
            if let value = patch.aiConsentVersion { row.aiConsentVersion = value }
            if let value = patch.calibrationOptIn { row.calibrationOptIn = value }
            if let value = patch.consumptionConsent { row.consumptionConsent = value }
            return row
        }
        // Keep my_status' consent block in sync, like the server.
        status.mutate { status in
            status.consent.pdpl.accepted = updated.pdplConsentVersion
            status.consent.ai.accepted = updated.aiConsentVersion
            status.consent.upToDate = status.consent.pdpl.isCurrent && status.consent.ai.isCurrent
        }
        return updated
    }
}

final class MockAnalysisAPI: AnalysisAPI, @unchecked Sendable {
    let backend: MockBackend
    let catalogValue = Locked<CatalogResponseV1>(.preview)
    let submitted = Locked<[String]>([])
    let uploaded = Locked<[String: [FrameId]]>([:])
    /// Results by analysis id; unknown ids fall back to the bundled `example_full.json` fixture.
    let results = Locked<[String: CoachResultV1]>([:])
    let historyItems = Locked<[HistoryItem]>([])
    let prepareResponse = Locked<PrepareResponseV1?>(nil)

    init(backend: MockBackend = MockBackend()) {
        self.backend = backend
    }

    func catalog() async throws -> CatalogResponseV1 {
        if let failure = backend.failure.get() { throw failure }
        return catalogValue.get()
    }

    func prepare(_ pose: PoseV1) async throws -> PrepareResponseV1 {
        if let failure = backend.failure.get() { throw failure }
        if let response = prepareResponse.get() { return response }
        if let fixture = FixtureLoader.decode(PrepareResponseV1.self, named: "prepare_example") { return fixture }
        throw AppError.api(ApiError(code: ApiErrorCode.noStrokesDetected.rawValue, tips: [TipKey.repetitions.rawValue]), status: 422)
    }

    func reprepare(_ request: ReprepareV1) async throws -> PrepareResponseV1 {
        if let failure = backend.failure.get() { throw failure }
        if let response = prepareResponse.get() { return response }
        throw AppError.api(ApiError(code: ApiErrorCode.analysisNotFound.rawValue), status: 404)
    }

    func uploadFrames(
        analysisId: String,
        frames: [FrameUpload],
        progress: @escaping @Sendable (_ done: Int, _ total: Int) -> Void
    ) async throws {
        if let failure = backend.failure.get() { throw failure }
        for (index, frame) in frames.enumerated() {
            uploaded.mutate { $0[analysisId, default: []].append(frame.frameId) }
            progress(index + 1, frames.count)
        }
    }

    func submit(analysisId: String, deviceCheckToken: String?) async throws -> SubmitResponse {
        if let failure = backend.failure.get() { throw failure }
        submitted.mutate { $0.append(analysisId) }
        return SubmitResponse(status: .queued, pollAfterMs: 2000)
    }

    func poll(analysisId: String) async throws -> AnalysisRow {
        if let failure = backend.failure.get() { throw failure }
        return AnalysisRow(
            id: analysisId, sport: .badminton, skill: "bd.clear_fh", status: .succeeded, failureCode: nil,
            cameraView: "diagonal", subject: .oneself, createdAt: nil, completedAt: nil
        )
    }

    func result(analysisId: String) async throws -> CoachResultV1 {
        if let failure = backend.failure.get() { throw failure }
        if let stored = results.get()[analysisId] { return stored }
        let name = backend.status.get().features.fullReport ? "example_full" : "example_free"
        if let fixture = FixtureLoader.decode(CoachResultV1.self, named: name) { return fixture }
        throw AppError.api(ApiError(code: ApiErrorCode.analysisNotFound.rawValue), status: 404)
    }

    func cleanTrack(analysisId: String, path: String?) async throws -> Data {
        throw AppError.api(ApiError(code: ApiErrorCode.notFound.rawValue), status: 404)
    }

    func history(limit: Int, before: String?) async throws -> [HistoryItem] {
        if let failure = backend.failure.get() { throw failure }
        return Array(historyItems.get().prefix(limit))
    }

    func progress(sport: Sport, skill: String?) async throws -> [ProgressPoint] {
        if let failure = backend.failure.get() { throw failure }
        guard backend.status.get().features.progress else {
            throw AppError.api(ApiError(code: ApiErrorCode.forbidden.rawValue), status: 403)
        }
        return []
    }

    func sendFeedback(_ feedback: FeedbackBody) async throws {}

    func deleteAnalysis(analysisId: String) async throws {
        historyItems.mutate { $0.removeAll { $0.id == analysisId } }
    }
}

final class MockAccountAPI: AccountAPI, @unchecked Sendable {
    let mergedTokens = Locked<[String]>([])
    let exchangedCodes = Locked<[String]>([])
    let verifyResponse = Locked<VerifySubscriptionResponse>(
        VerifySubscriptionResponse(
            tier: .premium, productId: "premium.yearly", expiresAt: nil, willRenew: true, inGrace: false,
            billingIssue: false, isTrial: false, transferred: false
        )
    )

    func appleAuthExchange(authorizationCode: String) async throws {
        exchangedCodes.mutate { $0.append(authorizationCode) }
    }

    func mergeAnonymousAccount(anonAccessToken: String) async throws -> AccountMergeResponse {
        mergedTokens.mutate { $0.append(anonAccessToken) }
        return AccountMergeResponse(merged: true)
    }

    func deleteAccount() async throws -> DeleteAccountResponse {
        DeleteAccountResponse(deleted: true, hadActiveSubscription: false, siwaManualRevoke: false)
    }

    func verifySubscription(_ request: VerifySubscriptionRequest) async throws -> VerifySubscriptionResponse {
        verifyResponse.get()
    }
}

final class MockEventLogger: EventLogger, @unchecked Sendable {
    let events = Locked<[(AnalyticsEvent, [String: JSONValue])]>([])

    func log(_ event: AnalyticsEvent, props: [String: JSONValue]) {
        events.mutate { $0.append((event, props)) }
    }

    func flush() async {}

    var names: [AnalyticsEvent] { events.get().map(\.0) }
}

struct MockDeviceCheck: DeviceCheckProviding {
    var value: String? = nil
    func token() async -> String? { value }
}

final class MockNetworkMonitor: NetworkMonitoring, @unchecked Sendable {
    private let online = Locked(true)
    private let continuations = Locked<[UUID: AsyncStream<Bool>.Continuation]>([:])

    var isOnline: Bool { online.get() }

    func changes() -> AsyncStream<Bool> {
        AsyncStream { continuation in
            let id = UUID()
            continuations.mutate { $0[id] = continuation }
            continuation.yield(online.get())
            continuation.onTermination = { [weak self] _ in
                self?.continuations.mutate { $0[id] = nil }
            }
        }
    }

    func setOnline(_ value: Bool) {
        online.set(value)
        for continuation in continuations.get().values { continuation.yield(value) }
    }
}

// MARK: - Sample values

extension MyStatus {
    /// A plausible `my_status()` answer (free: 2 per calendar month, 1 left; resets on the 1st, ICT).
    static func preview(tier: Tier = .free, remaining: Int = 1) -> MyStatus {
        let total: Int
        let standard: Int
        let periodType: CatalogPlan.PeriodType
        switch tier {
        case .free: (total, standard, periodType) = (2, 1, .calendarMonth)
        case .trial: (total, standard, periodType) = (10, 5, .trial)
        case .premium: (total, standard, periodType) = (15, 15, .subscriptionMonth)
        }
        let paid = tier != .free
        return MyStatus(
            tier: tier,
            periodType: periodType,
            periodKey: "2026-10",
            used: Usage(total: max(total - remaining, 0), standard: 0, retries: 0),
            limits: Limits(total: total, standard: standard, retries: 3, inFlight: 1),
            remaining: remaining,
            inFlight: 0,
            nextKind: paid ? .standard : .basic,
            resetsAt: tier == .trial ? nil : "2026-11-01T00:00:00+07:00",
            bonusAvailable: false,
            features: Features(fullReport: paid, progress: paid, player: paid, historyFullLimit: paid ? nil : 3),
            copy: [
                Tier.free.rawValue: PlanCopy(periodType: .calendarMonth, totalLimit: 2, standardLimit: 1),
                Tier.trial.rawValue: PlanCopy(periodType: .trial, totalLimit: 10, standardLimit: 5),
                Tier.premium.rawValue: PlanCopy(periodType: .subscriptionMonth, totalLimit: 15, standardLimit: 15),
            ],
            entitlement: paid
                ? Entitlement(isTrial: tier == .trial, productId: "premium.yearly", expiresAt: "2026-11-12T10:00:00+07:00",
                              willRenew: true, inGrace: false, billingIssue: false)
                : .none,
            consent: ConsentStatus(
                pdpl: ConsentItem(current: "2026-10-01", accepted: nil),
                ai: ConsentItem(current: "2026-10-01", accepted: nil),
                upToDate: false
            ),
            isReviewer: false,
            isAnonymous: true
        )
    }
}

extension CatalogResponseV1 {
    /// The six launch skills (DESIGN.md §2.1) with their recommended views.
    static let preview = CatalogResponseV1(
        skills: [
            CatalogSkill(id: "bd.clear_fh", sport: .badminton, name: LocalizedText(vi: "Phông cầu thuận tay", en: "Forehand overhead clear"),
                         views: .init(recommended: [.D], allowed: [.D, .B, .S]), viewCoverage: ["D": 0.85, "B": 0.7, "S": 0.75], solo: false),
            CatalogSkill(id: "bd.smash", sport: .badminton, name: LocalizedText(vi: "Đập cầu", en: "Smash"),
                         views: .init(recommended: [.D], allowed: [.D, .B, .S]), viewCoverage: ["D": 0.85, "B": 0.7, "S": 0.75], solo: false),
            CatalogSkill(id: "bd.serve_low", sport: .badminton, name: LocalizedText(vi: "Giao cầu thấp trái tay", en: "Low backhand serve"),
                         views: .init(recommended: [.S], allowed: [.S, .D]), viewCoverage: ["S": 0.9, "D": 0.8], solo: true),
            CatalogSkill(id: "pb.serve", sport: .pickleball, name: LocalizedText(vi: "Giao bóng", en: "Serve"),
                         views: .init(recommended: [.S], allowed: [.S, .D]), viewCoverage: ["S": 0.9, "D": 0.8], solo: true),
            CatalogSkill(id: "pb.dink", sport: .pickleball, name: LocalizedText(vi: "Dink", en: "Dink"),
                         views: .init(recommended: [.S], allowed: [.S, .D]), viewCoverage: ["S": 0.85, "D": 0.75], solo: false),
            CatalogSkill(id: "pb.drop3", sport: .pickleball, name: LocalizedText(vi: "Drop cú thứ ba", en: "Third-shot drop"),
                         views: .init(recommended: [.S], allowed: [.S, .D, .B]), viewCoverage: ["S": 0.85, "D": 0.75, "B": 0.6], solo: false),
        ],
        plans: [
            CatalogPlan(tier: .free, periodType: .calendarMonth, totalLimit: 2, standardLimit: 1),
            CatalogPlan(tier: .trial, periodType: .trial, totalLimit: 10, standardLimit: 5),
            CatalogPlan(tier: .premium, periodType: .subscriptionMonth, totalLimit: 15, standardLimit: 15),
        ]
    )
}
