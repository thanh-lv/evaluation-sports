import CoachCore
import Foundation

/// Quota, entitlement and consent snapshot plus the public app configuration (DESIGN.md §5.2, §9.4 step 6: the app
/// gates features only on `my_status()` and `get_result`).
protocol StatusAPI: Sendable {
    /// `rpc("my_status")`.
    func myStatus() async throws -> MyStatus
    /// `select key, value from app_config` (readable by everyone): minimum age and consent versions.
    func appConfig() async throws -> AppConfigValues
}

/// The caller's `profiles` row (SELECT own; UPDATE own on the client-writable columns).
protocol ProfileAPI: Sendable {
    func profile() async throws -> Profile
    /// Writes only the fields set in `patch` and returns the updated row. The database rejects a birth year below
    /// `app_config.min_user_age` (`under_min_age`) or exactly at it without `ageAttested` (`age_attestation_required`).
    func update(_ patch: ProfilePatch) async throws -> Profile
}

/// Account-level Edge Functions (DESIGN.md §6.1, CONTRACTS.md `api_v1.ts`).
protocol AccountAPI: Sendable {
    /// `POST /apple-auth-exchange`: stores the Sign in with Apple refresh token (needed to revoke it on deletion).
    func appleAuthExchange(authorizationCode: String) async throws
    /// `POST /account-merge` with the permanent account's JWT; `anonAccessToken` proves the anonymous account.
    func mergeAnonymousAccount(anonAccessToken: String) async throws -> AccountMergeResponse
    /// `POST /delete-account` (`{confirm: true}`), for every account type including anonymous.
    func deleteAccount() async throws -> DeleteAccountResponse
    /// `POST /verify-subscription` (StoreService). A 409 `linked_to_other_account` arrives as `AppError.api`.
    func verifySubscription(_ request: VerifySubscriptionRequest) async throws -> VerifySubscriptionResponse
}

/// First-party analytics (DESIGN.md D22): `rpc("log_event")`, batched. Names must be on the server allowlist
/// (`app_config.event_allowlist`, mirrored by `AnalyticsEvent`); props must be a JSON object of at most 2 KB and never
/// contain personal data (no email, birth year, free text).
protocol EventLogger: Sendable {
    /// Queues an event; never blocks and never throws.
    func log(_ event: AnalyticsEvent, props: [String: JSONValue])
    /// Sends the queued events now (app background, before sign-out).
    func flush() async
}

extension EventLogger {
    func log(_ event: AnalyticsEvent) { log(event, props: [:]) }
}

/// Client event names allowed by `app_config.event_allowlist` (supabase/seed.sql). Adding a case requires adding the
/// name to the allowlist first; `scripts/check_ios_resources.py` compares both lists.
enum AnalyticsEvent: String, CaseIterable, Sendable {
    case appOpen = "app_open"
    case onboardingStarted = "onboarding_started"
    case onboardingCompleted = "onboarding_completed"
    case languageChanged = "language_changed"
    case consentShown = "consent_shown"
    case consentAccepted = "consent_accepted"
    case consentWithdrawn = "consent_withdrawn"
    case cameraGuideViewed = "camera_guide_viewed"
    case analysisStarted = "analysis_started"
    case captureRecorded = "capture_recorded"
    case captureImported = "capture_imported"
    case trimCompleted = "trim_completed"
    case qualityRejected = "quality_rejected"
    case prepareCompleted = "prepare_completed"
    case prepareRejected = "prepare_rejected"
    case strokesConfirmed = "strokes_confirmed"
    case framesUploaded = "frames_uploaded"
    case analysisSubmitted = "analysis_submitted"
    case analysisFailed = "analysis_failed"
    case resultViewed = "result_viewed"
    case evidenceOpened = "evidence_opened"
    case lockedSectionTapped = "locked_section_tapped"
    case feedbackGiven = "feedback_given"
    case reminderSet = "reminder_set"
    case historyOpened = "history_opened"
    case progressOpened = "progress_opened"
    case playerOpened = "player_opened"
    case demoOpened = "demo_opened"
    case paywallViewed = "paywall_viewed"
    case purchaseStarted = "purchase_started"
    case purchaseCompleted = "purchase_completed"
    case purchaseFailed = "purchase_failed"
    case restoreTapped = "restore_tapped"
    case accountLinkStarted = "account_link_started"
    case accountLinked = "account_linked"
    case settingsOpened = "settings_opened"
    case localVideosDeleted = "local_videos_deleted"
}
