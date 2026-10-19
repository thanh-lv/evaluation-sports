import Foundation
import Supabase

/// Batched `rpc("log_event")` (DESIGN.md D22). Events are queued in memory and sent in one burst every
/// `flushInterval`, when `batchSize` events are waiting, or on `flush()` (app background). Each event is one RPC call
/// (the RPC takes one event). Failures keep the queue (capped) for the next flush; a rejected event (`PT422`, e.g. a
/// name missing from the server allowlist) is dropped. Nothing is sent before the anonymous sign-in succeeds.
final class SupabaseEventLogger: EventLogger {
    private let sink: EventSink

    init(provider: SupabaseProvider, batchSize: Int = 20, flushInterval: Duration = .seconds(30), maxQueued: Int = 200) {
        sink = EventSink(
            send: { name, props in
                let client = try provider.requireClient()
                guard provider.currentUserId != nil else { throw AppError.notSignedIn }
                do {
                    let params = LogEventParams(pName: name, pProps: props)
                    _ = try await client.rpc("log_event", params: params).execute()
                } catch {
                    throw AppError.from(supabase: error)
                }
            },
            batchSize: batchSize,
            flushInterval: flushInterval,
            maxQueued: maxQueued
        )
    }

    func log(_ event: AnalyticsEvent, props: [String: JSONValue]) {
        let sink = sink
        Task { await sink.enqueue(event.rawValue, props: props) }
    }

    func flush() async {
        await sink.flush()
    }
}

private struct LogEventParams: Encodable, Sendable {
    var pName: String
    var pProps: [String: JSONValue]

    enum CodingKeys: String, CodingKey {
        case pName = "p_name"
        case pProps = "p_props"
    }
}
