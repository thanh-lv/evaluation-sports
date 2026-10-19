import CoachCore
import Foundation

/// The in-app language picker (DESIGN.md D15, §5.2 L10n): System / Tiếng Việt / English.
///
/// `system` does not simply follow iOS: it resolves to Vietnamese whenever the App Store storefront is Vietnam (`VNM`)
/// or the device region is Vietnam, whatever the system language. Otherwise it follows the first preferred language
/// (Vietnamese if it starts with `vi`, English for everything else).
///
/// Foundation-only so it is unit-testable everywhere; the storefront country is fetched once with StoreKit by
/// `StorefrontLanguageDefault` and cached in `UserDefaults` under `storefrontCountryKey`.
enum AppLanguage: String, CaseIterable, Codable, Sendable, Identifiable {
    case system
    case vi
    case en

    var id: String { rawValue }

    /// `UserDefaults` key of the picked value (`AppLanguage.rawValue`).
    static let storageKey = "app.language"
    /// `UserDefaults` key of the last known App Store storefront country (ISO 3166-1 alpha-3, e.g. `VNM`).
    static let storefrontCountryKey = "app.storefrontCountry"

    /// The concrete language for this choice on this device.
    func resolved(
        storefrontCountry: String?,
        regionCode: String?,
        preferredLanguages: [String]
    ) -> Language {
        switch self {
        case .vi: return .vi
        case .en: return .en
        case .system:
            return AppLanguage.defaultLanguage(
                storefrontCountry: storefrontCountry,
                regionCode: regionCode,
                preferredLanguages: preferredLanguages
            )
        }
    }

    /// D15 default: VI when the storefront is VNM or the region is VN; otherwise the first preferred language.
    static func defaultLanguage(storefrontCountry: String?, regionCode: String?, preferredLanguages: [String]) -> Language {
        if storefrontCountry?.uppercased() == "VNM" { return .vi }
        if regionCode?.uppercased() == "VN" { return .vi }
        if let first = preferredLanguages.first?.lowercased(), first == "vi" || first.hasPrefix("vi-") || first.hasPrefix("vi_") {
            return .vi
        }
        return .en
    }

    /// The picked value from `UserDefaults` (`system` when unset or unknown).
    static func stored(in defaults: UserDefaults = .standard) -> AppLanguage {
        defaults.string(forKey: storageKey).flatMap(AppLanguage.init(rawValue:)) ?? .system
    }

    static func store(_ value: AppLanguage, in defaults: UserDefaults = .standard) {
        defaults.set(value.rawValue, forKey: storageKey)
    }

    /// The language the UI uses right now, from the stored choice, the cached storefront and the device settings.
    /// Safe to call from any thread (non-view code, logging, notifications).
    static func currentResolved(defaults: UserDefaults = .standard) -> Language {
        stored(in: defaults).resolved(
            storefrontCountry: defaults.string(forKey: storefrontCountryKey),
            regionCode: Locale.current.region?.identifier,
            preferredLanguages: Locale.preferredLanguages
        )
    }

    /// `profiles.locale`: nil means "follow the default" (column comment in migration 0100).
    var profileLocale: Language? {
        switch self {
        case .system: return nil
        case .vi: return .vi
        case .en: return .en
        }
    }

    /// Name shown in the picker. Each language is written in its own language, as iOS does; `system` is localized.
    var pickerTitleKey: String {
        switch self {
        case .system: return "language.system"
        case .vi: return "language.vi"
        case .en: return "language.en"
        }
    }
}

extension Language {
    /// Locale for formatting and SwiftUI lookup (`.environment(\.locale, …)`).
    var locale: Locale { Locale(identifier: rawValue) }
}
