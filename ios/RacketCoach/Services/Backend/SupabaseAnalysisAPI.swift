import CoachCore
import Foundation
import Supabase

/// `AnalysisAPI` on supabase-swift. Routes: `analyze/catalog` (GET), `analyze/prepare`, `analyze/submit` (POST);
/// PostgREST `analyses` and the client RPCs; Storage buckets `analysis-inputs` / `analysis-derived`.
struct SupabaseAnalysisAPI: AnalysisAPI {
    let provider: SupabaseProvider

    /// At most 3 key-frame uploads in flight (DESIGN.md §5.2).
    static let maxParallelUploads = 3

    func catalog() async throws -> CatalogResponseV1 {
        try await provider.invokeGet("analyze/catalog", as: CatalogResponseV1.self)
    }

    func prepare(_ pose: PoseV1) async throws -> PrepareResponseV1 {
        let body: Data
        do {
            body = try pose.encodedForUpload()
        } catch {
            throw AppError.api(ApiError(code: ApiErrorCode.payloadTooLarge.rawValue, message: "\(error)"), status: 413)
        }
        return try await provider.invoke("analyze/prepare", jsonBody: body, as: PrepareResponseV1.self)
    }

    func reprepare(_ request: ReprepareV1) async throws -> PrepareResponseV1 {
        try await provider.invoke("analyze/prepare", body: request, as: PrepareResponseV1.self)
    }

    func uploadFrames(
        analysisId: String,
        frames: [FrameUpload],
        progress: @escaping @Sendable (_ done: Int, _ total: Int) -> Void
    ) async throws {
        let client = try provider.requireClient()
        let userId = try provider.requireUserId()
        var jobs: [(path: String, fileURL: URL)] = []
        for frame in frames {
            guard let path = StoragePaths.frame(userId: userId, analysisId: analysisId, frameId: frame.frameId) else {
                throw AppError.api(ApiError(code: ApiErrorCode.invalidPayload.rawValue, message: "frame \(frame.frameId.rawValue)"), status: 422)
            }
            jobs.append((path, frame.fileURL))
        }
        let total = jobs.count
        guard total > 0 else { return }
        let bucket = client.storage.from(StoragePaths.inputsBucket)
        let options = FileOptions(cacheControl: "0", contentType: "image/jpeg", upsert: true)

        try await withThrowingTaskGroup(of: Void.self) { group in
            var next = 0
            var done = 0
            func addNext() {
                guard next < jobs.count else { return }
                let job = jobs[next]
                next += 1
                group.addTask {
                    do {
                        _ = try await bucket.upload(job.path, fileURL: job.fileURL, options: options)
                    } catch {
                        throw AppError.from(supabase: error)
                    }
                }
            }
            for _ in 0..<min(Self.maxParallelUploads, jobs.count) { addNext() }
            while try await group.next() != nil {
                done += 1
                progress(done, total)
                addNext()
            }
        }
    }

    func submit(analysisId: String, deviceCheckToken: String?) async throws -> SubmitResponse {
        let request = SubmitRequest(analysisId: analysisId, deviceCheckToken: deviceCheckToken)
        return try await provider.invoke("analyze/submit", body: request, as: SubmitResponse.self)
    }

    func poll(analysisId: String) async throws -> AnalysisRow {
        let id = IDs.lower(analysisId) ?? analysisId.lowercased()
        return try await provider.database { client in
            let response: PostgrestResponse<AnalysisRow> = try await client.from("analyses")
                .select(AnalysisRow.pollColumns)
                .eq("id", value: id)
                .single()
                .execute()
            return response.value
        }
    }

    func result(analysisId: String) async throws -> CoachResultV1 {
        let params = ["p_analysis_id": IDs.lower(analysisId) ?? analysisId.lowercased()]
        return try await provider.database { client in
            let response: PostgrestResponse<CoachResultV1> = try await client.rpc("get_result", params: params).execute()
            return response.value
        }
    }

    func cleanTrack(analysisId: String, path: String?) async throws -> Data {
        let client = try provider.requireClient()
        let objectPath: String
        if let path, !path.isEmpty {
            objectPath = path
        } else {
            let userId = try provider.requireUserId()
            guard let built = StoragePaths.cleanTrack(userId: userId, analysisId: analysisId) else {
                throw AppError.api(ApiError(code: ApiErrorCode.analysisNotFound.rawValue), status: 404)
            }
            objectPath = built
        }
        do {
            return try await client.storage.from(StoragePaths.derivedBucket).download(path: objectPath)
        } catch {
            throw AppError.from(supabase: error)
        }
    }

    func history(limit: Int, before: String?) async throws -> [HistoryItem] {
        let params = HistoryParams(pLimit: limit, pBefore: before)
        return try await provider.database { client in
            let response: PostgrestResponse<[HistoryItem]> = try await client.rpc("get_history", params: params).execute()
            return response.value
        }
    }

    func progress(sport: Sport, skill: String?) async throws -> [ProgressPoint] {
        let params = ProgressParams(pSport: sport.rawValue, pSkill: skill)
        return try await provider.database { client in
            let response: PostgrestResponse<[ProgressPoint]> = try await client.rpc("get_progress", params: params).execute()
            return response.value
        }
    }

    func sendFeedback(_ feedback: FeedbackBody) async throws {
        var body = feedback
        body.analysisId = IDs.lower(feedback.analysisId) ?? feedback.analysisId.lowercased()
        do {
            try await provider.database { client in
                _ = try await client.from("feedback").insert(body, returning: .minimal).execute()
            }
        } catch let error as AppError where error.httpStatus == 409 {
            // Already rated (one row per analysis and user; the table has no client UPDATE policy).
        }
    }

    func deleteAnalysis(analysisId: String) async throws {
        let client = try provider.requireClient()
        let userId = try provider.requireUserId()
        let id = IDs.lower(analysisId) ?? analysisId.lowercased()
        // Storage first (best effort: frames are usually already deleted by the server after the analysis).
        let frames = StoragePaths.allFrames(userId: userId, analysisId: id)
        if !frames.isEmpty {
            _ = try? await client.storage.from(StoragePaths.inputsBucket).remove(paths: frames)
        }
        let derived = [StoragePaths.cleanTrack(userId: userId, analysisId: id), StoragePaths.rawPose(userId: userId, analysisId: id)]
            .compactMap { $0 }
        _ = try? await client.storage.from(StoragePaths.derivedBucket).remove(paths: derived)
        try await provider.database { client in
            _ = try await client.from("analyses").delete(returning: .minimal).eq("id", value: id).execute()
        }
    }
}

private struct HistoryParams: Encodable, Sendable {
    var pLimit: Int
    var pBefore: String?

    enum CodingKeys: String, CodingKey {
        case pLimit = "p_limit"
        case pBefore = "p_before"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(pLimit, forKey: .pLimit)
        try container.encodeIfPresent(pBefore, forKey: .pBefore)
    }
}

private struct ProgressParams: Encodable, Sendable {
    var pSport: String
    var pSkill: String?

    enum CodingKeys: String, CodingKey {
        case pSport = "p_sport"
        case pSkill = "p_skill"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(pSport, forKey: .pSport)
        try container.encodeIfPresent(pSkill, forKey: .pSkill)
    }
}
