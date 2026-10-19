import Foundation

/// DeviceCheck token for the free first-ever advanced analysis (DESIGN.md D18, §5.2 Device). Attach it to the first
/// submit only (`MyStatus.bonusAvailable`). Unavailable (Simulator, old devices, errors) returns nil, which means no
/// bonus; it never blocks the submit.
protocol DeviceCheckProviding: Sendable {
    func token() async -> String?
}

/// Online/offline state for retrying the anonymous sign-in, flushing events and resuming pending uploads
/// (DESIGN.md §5.2 Pipeline: "resume on launch, foreground or network change").
protocol NetworkMonitoring: Sendable {
    var isOnline: Bool { get }
    /// Emits the current state first, then every change.
    func changes() -> AsyncStream<Bool>
}
