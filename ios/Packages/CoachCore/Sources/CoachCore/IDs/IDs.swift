import Foundation

/// UUID canonicalisation (DESIGN.md D14, §5.3).
///
/// `UUID.uuidString` is UPPERCASE on Apple platforms, but Storage RLS paths, `analysisId` and `appAccountToken`
/// comparisons on the server are lowercase. Every UUID that leaves the device goes through `IDs.lower`.
public enum IDs {
    /// Lowercase canonical form, e.g. `0b0c4f1e-5a8d-4c47-9b1e-6c1f2a3b4c5d`.
    public static func lower(_ id: UUID) -> String {
        id.uuidString.lowercased()
    }

    /// Parses any-case UUID text and returns the lowercase canonical form, or nil when it is not a UUID.
    public static func lower(_ text: String) -> String? {
        guard let id = UUID(uuidString: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return lower(id)
    }

    /// True when `text` is already a lowercase canonical UUID (what the server's `LowerUuid` accepts).
    public static func isLowerCanonical(_ text: String) -> Bool {
        guard let canonical = lower(text) else { return false }
        return canonical == text
    }

    /// A fresh analysis id in lowercase canonical form.
    public static func newId() -> String {
        lower(UUID())
    }
}
