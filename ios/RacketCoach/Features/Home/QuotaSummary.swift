import CoachCore
import Foundation

/// Text of Home's quota chip from `my_status()` (DESIGN.md §2.2 step 3, §9.3 cap messaging):
/// free "Còn 1/2 lượt tháng này", trial "Dùng thử: còn 8/10 lượt", premium "Còn 12/15 lượt · Lượt mới vào 12/11";
/// at the cap free users get the paywall, trial and premium users get the date of the next analysis.
struct QuotaSummary: Equatable, Sendable {
    enum Tone: Equatable, Sendable {
        case normal
        /// One analysis left.
        case low
        /// None left.
        case empty
    }

    var text: String
    var tone: Tone
    /// "Phân tích nâng cao miễn phí lần đầu" (the free first-ever advanced analysis is still available).
    var showsBonus: Bool

    static func make(status: MyStatus?, language: Language) -> QuotaSummary? {
        guard let status else { return nil }
        let remaining = max(status.remaining, 0)
        let total = max(status.limits.total, remaining)
        let tone: Tone = remaining == 0 ? .empty : (remaining == 1 ? .low : .normal)
        let resets = status.resetsAtDate.map { L10nFormat.shortDayMonth($0, language: language) } ?? "—"
        let text: String
        switch status.tier {
        case .free:
            text = remaining > 0
                ? L10n.format("home.quota.free_remaining", remaining, total, language: language)
                : L10n.format("home.quota.free_empty", resets, language: language)
        case .trial:
            let trialEnd = L10nFormat.parseISO8601(status.entitlement.expiresAt)
                .map { L10nFormat.shortDayMonth($0, language: language) } ?? "—"
            text = remaining > 0
                ? L10n.format("home.quota.trial_remaining", remaining, total, language: language)
                : L10n.format("home.quota.trial_empty", trialEnd, language: language)
        case .premium:
            text = remaining > 0
                ? L10n.format("home.quota.premium_remaining", remaining, total, resets, language: language)
                : L10n.format("home.quota.premium_empty", resets, language: language)
        }
        return QuotaSummary(text: text, tone: tone, showsBonus: status.tier == .free && status.bonusAvailable)
    }
}
