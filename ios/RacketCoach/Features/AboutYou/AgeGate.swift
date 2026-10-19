import Foundation

/// Birth-year gate (DESIGN.md D21, §2.2 step 2), mirroring the `profiles` trigger: below the minimum age is blocked
/// (`under_min_age`); a birth year exactly at the threshold needs the attestation "I am at least N"
/// (`age_attestation_required`), because the birthday may not have passed yet.
enum AgeGate {
    enum Verdict: Sendable, Equatable {
        case allowed
        case needsAttestation
        case blocked
    }

    static func evaluate(birthYear: Int, currentYear: Int, minimumAge: Int) -> Verdict {
        let age = currentYear - birthYear
        if age > minimumAge { return .allowed }
        if age == minimumAge { return .needsAttestation }
        return .blocked
    }

    /// Years offered by the picker, newest first: from this year back 100 years.
    static func selectableYears(currentYear: Int) -> [Int] {
        Array(stride(from: currentYear, through: currentYear - 100, by: -1))
    }

    /// The current year in ICT (the server's calendar for this check).
    static func currentYear(now: Date) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = L10nFormat.ictTimeZone
        return calendar.component(.year, from: now)
    }
}
