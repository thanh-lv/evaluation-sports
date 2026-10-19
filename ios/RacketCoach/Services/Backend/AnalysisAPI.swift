import CoachCore
import Foundation

/// Analysis endpoints (DESIGN.md §5.2 Backend, §3 diagram). Every analysis id is passed and returned lowercase
/// (`IDs.lower`). Errors are always `AppError` (`.api` carries the contracts `ApiError`, e.g. a prepare rejection with
/// its tips, `quota_exceeded`, `consent_required`).
///
/// Live implementation: `SupabaseAnalysisAPI`. Previews and tests: `MockAnalysisAPI`.
protocol AnalysisAPI: Sendable {
    /// `GET /analyze/catalog`: enabled skills (names, recommended views, coverage, solo) and plan numbers.
    func catalog() async throws -> CatalogResponseV1

    /// `POST /analyze/prepare` with a `pose.v1` body (`PoseV1.encodedForUpload()`). Free, uses no quota. A clip the
    /// engine rejects throws `.api(ApiError)` with a prepare rejection code (422) and tip keys.
    func prepare(_ pose: PoseV1) async throws -> PrepareResponseV1

    /// `POST /analyze/prepare` with a `reprepare.v1` body (view change, excluded strokes, handedness). Free.
    func reprepare(_ request: ReprepareV1) async throws -> PrepareResponseV1

    /// Uploads the rendered key frames to Storage `analysis-inputs/{uid}/{aid}/frames/F#.jpg` with `upsert: true`,
    /// at most 3 in parallel. Only F1–F5 are accepted. `progress(done, total)` is called after each upload.
    func uploadFrames(
        analysisId: String,
        frames: [FrameUpload],
        progress: @escaping @Sendable (_ done: Int, _ total: Int) -> Void
    ) async throws

    /// `POST /analyze/submit`. Attach `deviceCheckToken` only when `MyStatus.bonusAvailable` (first-ever analysis).
    func submit(analysisId: String, deviceCheckToken: String?) async throws -> SubmitResponse

    /// One PostgREST read of the column-granted `analyses` row (status, failure code). See `AnalysisPolling`.
    func poll(analysisId: String) async throws -> AnalysisRow

    /// `rpc("get_result")`: the coach-result.v1 redacted by the caller's current tier.
    func result(analysisId: String) async throws -> CoachResultV1

    /// Downloads `analysis-derived/{uid}/{aid}/pose.clean.json` (raw JSON; decode with `CleanTrackV1.decode(_:)`).
    /// `path` is `PrepareResponseV1.cleanTrackPath` when known; nil builds it from the signed-in user id.
    func cleanTrack(analysisId: String, path: String?) async throws -> Data

    /// `rpc("get_history")`, newest first. Free users get locked stubs past the newest 3.
    func history(limit: Int, before: String?) async throws -> [HistoryItem]

    /// `rpc("get_progress")`, oldest first (premium/trial only; free → `.api(forbidden)`).
    func progress(sport: Sport, skill: String?) async throws -> [ProgressPoint]

    /// Thumbs feedback (`feedback` table).
    func sendFeedback(_ feedback: FeedbackBody) async throws

    /// Deletes the analysis row and its Storage objects (frames and pose files).
    func deleteAnalysis(analysisId: String) async throws
}

extension CleanTrackV1 {
    /// Decodes a downloaded or cached `pose.clean.json`.
    static func decode(_ data: Data) throws -> CleanTrackV1 {
        try JSONDecoder().decode(CleanTrackV1.self, from: data)
    }
}

/// Polls `analyses.status` until the job finishes (DESIGN.md §3: 2 s → 5 s backoff, 5 min cap).
enum AnalysisPolling {
    enum Outcome: Sendable, Equatable {
        /// `succeeded`, `rejected` or `failed`; fetch the result with `AnalysisAPI.result` when it succeeded.
        case finished(AnalysisRow)
        /// Still queued/processing after the cap: tell the user it will appear in History.
        case stillRunning(AnalysisRow?)
    }

    static let initialDelay: Duration = .seconds(2)
    static let maxDelay: Duration = .seconds(5)
    static let cap: Duration = .seconds(300)

    /// The delay before poll number `attempt` (0-based): 2 s, 3 s, 4 s, then 5 s.
    static func delay(forAttempt attempt: Int) -> Duration {
        min(initialDelay + .seconds(attempt), maxDelay)
    }

    /// Polls until a terminal status, cancellation or the cap. Transient errors (offline, 5xx) are retried until the
    /// cap; any other error is thrown. `firstDelay` is `SubmitResponse.pollAfterMs` when known.
    static func waitForTerminalStatus(
        analysisId: String,
        api: any AnalysisAPI,
        clock: any AppClock,
        firstDelay: Duration? = nil,
        cap: Duration = AnalysisPolling.cap
    ) async throws -> Outcome {
        let start = clock.now()
        var attempt = 0
        var last: AnalysisRow?
        var nextDelay = firstDelay ?? delay(forAttempt: 0)
        while true {
            try await clock.sleep(for: nextDelay)
            do {
                let row = try await api.poll(analysisId: analysisId)
                last = row
                if row.isFinished { return .finished(row) }
            } catch let error as AppError where error.isTransient {
                // Keep polling: the job runs on the server whatever the network does.
            }
            attempt += 1
            nextDelay = delay(forAttempt: attempt)
            let elapsed = clock.now().timeIntervalSince(start)
            if elapsed + nextDelay.timeInterval > cap.timeInterval { return .stillRunning(last) }
        }
    }
}

extension Duration {
    /// Seconds as a `TimeInterval`.
    var timeInterval: TimeInterval {
        let parts = components
        return TimeInterval(parts.seconds) + TimeInterval(parts.attoseconds) / 1e18
    }
}
