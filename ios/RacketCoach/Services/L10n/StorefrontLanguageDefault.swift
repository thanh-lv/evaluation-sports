import Foundation
import StoreKit

/// Caches the App Store storefront country used by the D15 default (`AppLanguage.system` → VI for `VNM`).
///
/// `Storefront.current` is async, so the value is fetched at launch and stored in `UserDefaults`; the first launch
/// before it arrives falls back to the device region and languages. `Storefront.updates` keeps it current.
enum StorefrontLanguageDefault {
    /// Fetches the storefront country and stores it. Returns true when the stored value changed.
    @discardableResult
    static func refresh(defaults: UserDefaults = .standard) async -> Bool {
        guard let storefront = await Storefront.current else { return false }
        return store(country: storefront.countryCode, defaults: defaults)
    }

    /// Listens for storefront changes for the life of the calling task; `onChange` runs when the country changes.
    static func observe(defaults: UserDefaults = .standard, onChange: @escaping @Sendable () async -> Void) async {
        for await storefront in Storefront.updates {
            if store(country: storefront.countryCode, defaults: defaults) {
                await onChange()
            }
        }
    }

    private static func store(country: String, defaults: UserDefaults) -> Bool {
        let previous = defaults.string(forKey: AppLanguage.storefrontCountryKey)
        guard previous != country else { return false }
        defaults.set(country, forKey: AppLanguage.storefrontCountryKey)
        return true
    }
}
