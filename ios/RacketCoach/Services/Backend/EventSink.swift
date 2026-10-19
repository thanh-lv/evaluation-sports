import Foundation

/// The queue behind `SupabaseEventLogger` (Foundation-only, unit-tested with a fake `send`).
actor EventSink {
    typealias Send = @Sendable (_ name: String, _ props: [String: JSONValue]) async throws -> Void

    private struct Pending: Sendable {
        var name: String
        var props: [String: JSONValue]
    }

    private let send: Send
    private let batchSize: Int
    private let flushInterval: Duration
    private let maxQueued: Int
    private var queue: [Pending] = []
    private var flushing = false
    private var timer: Task<Void, Never>?

    init(send: @escaping Send, batchSize: Int, flushInterval: Duration, maxQueued: Int) {
        self.send = send
        self.batchSize = batchSize
        self.flushInterval = flushInterval
        self.maxQueued = maxQueued
    }

    var queuedCount: Int { queue.count }

    func enqueue(_ name: String, props: [String: JSONValue]) async {
        queue.append(Pending(name: name, props: props))
        if queue.count > maxQueued && !flushing { queue.removeFirst(queue.count - maxQueued) }
        if queue.count >= batchSize {
            await flush()
        } else if timer == nil {
            let interval = flushInterval
            timer = Task { [weak self] in
                try? await Task.sleep(for: interval)
                await self?.timerFired()
            }
        }
    }

    private func timerFired() async {
        timer = nil
        await flush()
    }

    func flush() async {
        guard !flushing, !queue.isEmpty else { return }
        flushing = true
        defer { flushing = false }
        while let event = queue.first {
            do {
                try await send(event.name, event.props)
                queue.removeFirst()
            } catch let error as AppError where error.isTransient || error == .notSignedIn || error == .notConfigured {
                return  // keep the queue for the next flush
            } catch {
                queue.removeFirst()  // rejected (invalid name or props): never retry
            }
        }
    }
}
