import Foundation
import Network

/// `NWPathMonitor` wrapper. One monitor per subscriber, so streams can be cancelled independently.
final class NetworkMonitor: NetworkMonitoring, @unchecked Sendable {
    private let lock = NSLock()
    private var online = true
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "app.racketcoach.network-monitor")

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            self?.setOnline(path.status == .satisfied)
        }
        monitor.start(queue: queue)
    }

    deinit {
        monitor.cancel()
    }

    var isOnline: Bool {
        lock.lock()
        defer { lock.unlock() }
        return online
    }

    private func setOnline(_ value: Bool) {
        lock.lock()
        online = value
        lock.unlock()
    }

    func changes() -> AsyncStream<Bool> {
        AsyncStream { continuation in
            let pathMonitor = NWPathMonitor()
            let last = LastValue()
            pathMonitor.pathUpdateHandler = { path in
                let value = path.status == .satisfied
                if last.replace(with: value) {
                    continuation.yield(value)
                }
            }
            pathMonitor.start(queue: DispatchQueue(label: "app.racketcoach.network-monitor.stream"))
            continuation.onTermination = { _ in pathMonitor.cancel() }
        }
    }
}

/// Remembers the last emitted value; `replace` returns true when the value changed.
private final class LastValue: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Bool?

    func replace(with newValue: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard value != newValue else { return false }
        value = newValue
        return true
    }
}
