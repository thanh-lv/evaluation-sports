import Foundation

/// Time source for everything that waits or timestamps (polling, retries, the 60-day clean-up, quota dates), so tests
/// and previews control time. Named `AppClock` because `Clock` is the Swift standard-library protocol.
protocol AppClock: Sendable {
    func now() -> Date
    func sleep(for duration: Duration) async throws
}

/// Wall-clock time and `Task.sleep` (monotonic; the app never reads boot time).
struct SystemClock: AppClock {
    func now() -> Date { Date() }

    func sleep(for duration: Duration) async throws {
        try await Task.sleep(for: duration)
    }
}

/// A clock for tests and previews: `now()` returns a settable date and `sleep` advances it instantly.
final class ManualClock: AppClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(now: Date = Date(timeIntervalSince1970: 1_792_000_000)) {
        current = now
    }

    func now() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func advance(by seconds: TimeInterval) {
        lock.lock()
        current = current.addingTimeInterval(seconds)
        lock.unlock()
    }

    func set(_ date: Date) {
        lock.lock()
        current = date
        lock.unlock()
    }

    func sleep(for duration: Duration) async throws {
        try Task.checkCancellation()
        advance(by: duration.timeInterval)
        await Task.yield()
    }
}
