import CoachCore
import Foundation

/// String lookup for code outside SwiftUI views (DESIGN.md §5.2 L10n, §10.1).
///
/// SwiftUI `Text("some.key")` resolves `LocalizedStringKey`s with the root `.environment(\.locale, …)`, so views can
/// use keys directly. Everything else (alerts built in models, error messages, notifications, formatted strings) must
/// go through `L10n`, which reads the compiled String Catalog from the `vi.lproj` / `en.lproj` bundle of the
/// language picked in the app, not the iOS language.
///
/// Keys are semantic (`home.quota.free`) and live in `Resources/Strings/<area>.json` fragments; values with
/// arguments use `String(format:)` specifiers (`%lld`, `%@`, positional `%1$lld`). Plural variations in the catalog
/// compile to `.stringsdict` and are honoured by `format`.
enum L10n {
    /// Localized value of `key` in `language` (default: the language currently picked in the app).
    /// A missing key returns the key itself, which `scripts/check_ios_resources.py` prevents for literal keys.
    static func string(_ key: String, language: Language? = nil) -> String {
        let lang = language ?? AppLanguage.currentResolved()
        return bundle(for: lang).localizedString(forKey: key, value: nil, table: nil)
    }

    /// Localized format string of `key` filled with `arguments` using the language's locale (digits, plurals).
    static func format(_ key: String, _ arguments: CVarArg..., language: Language? = nil) -> String {
        format(key, arguments: arguments, language: language)
    }

    static func format(_ key: String, arguments: [CVarArg], language: Language? = nil) -> String {
        let lang = language ?? AppLanguage.currentResolved()
        let format = bundle(for: lang).localizedString(forKey: key, value: nil, table: nil)
        return String(format: format, locale: lang.locale, arguments: arguments)
    }

    /// Localized tip copy for a server tip key (`camera.tip.*`); unknown keys are dropped by the caller.
    static func tip(_ tip: TipKey, language: Language? = nil) -> String {
        string(tip.rawValue, language: language)
    }

    /// The `.lproj` bundle of a language, falling back to the main bundle (development language) when missing.
    static func bundle(for language: Language) -> Bundle {
        switch language {
        case .vi: return Bundles.vi
        case .en: return Bundles.en
        }
    }

    private enum Bundles {
        static let vi: Bundle = load("vi")
        static let en: Bundle = load("en")

        static func load(_ name: String) -> Bundle {
            guard let path = Bundle.main.path(forResource: name, ofType: "lproj"), let bundle = Bundle(path: path) else {
                return Bundle.main
            }
            return bundle
        }
    }
}

/// Locale-aware formatting helpers shared by the features (numbers and dates always use the app language).
enum L10nFormat {
    /// ICT, the time zone every quota period uses (`Asia/Ho_Chi_Minh`, fixed +07:00).
    static let ictTimeZone: TimeZone = TimeZone(identifier: "Asia/Ho_Chi_Minh") ?? TimeZone(secondsFromGMT: 7 * 3600)!

    /// Parses the server's ISO 8601 timestamps (`2026-11-01T00:00:00+07:00`, with or without fractional seconds).
    static func parseISO8601(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: text) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        // Postgres `timestamptz` rendered by jsonb ("2026-11-01T00:00:00.123456+00:00") has 6 fractional digits.
        let trimmed = text.replacingOccurrences(of: #"\.(\d{3})\d+"#, with: ".$1", options: .regularExpression)
        return fractional.date(from: trimmed)
    }

    /// Short day/month date in ICT ("12/11" in Vietnamese, "11/12" in English).
    static func shortDayMonth(_ date: Date, language: Language) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .omitted, locale: language.locale, calendar: Calendar(identifier: .gregorian), timeZone: ictTimeZone)
        style = style.day(.defaultDigits).month(.defaultDigits)
        return date.formatted(style)
    }

    /// Medium date ("18 thg 10, 2026" / "Oct 18, 2026") in the device time zone.
    static func mediumDate(_ date: Date, language: Language) -> String {
        date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, locale: language.locale))
    }
}
