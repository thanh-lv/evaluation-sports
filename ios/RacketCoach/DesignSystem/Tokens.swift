import SwiftUI
import UIKit

/// Design tokens (spacing, radii, colors, type). Colors adapt to light and dark mode; fonts use text styles so they
/// scale with Dynamic Type (DESIGN.md §10.1: tested at XL sizes with long Vietnamese strings).
enum DS {
    enum Spacing {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let s: CGFloat = 12
        static let m: CGFloat = 16
        static let l: CGFloat = 24
        static let xl: CGFloat = 32
        static let xxl: CGFloat = 48
    }

    enum Radius {
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
    }

    /// Minimum tappable height (Apple HIG 44 pt; primary buttons are taller).
    static let minTapHeight: CGFloat = 44
    static let primaryButtonHeight: CGFloat = 52
}

extension Color {
    /// Brand green (asset `AccentColor`, light and dark variants).
    static let rcAccent = Color("AccentColor")
    static let rcAccentSoft = Color(uiColor: .dynamic(light: 0xE3F4EC, dark: 0x16352A))
    static let rcOnAccent = Color.white

    static let rcBackground = Color(uiColor: .systemGroupedBackground)
    static let rcSurface = Color(uiColor: .secondarySystemGroupedBackground)
    static let rcSurfaceRaised = Color(uiColor: .tertiarySystemGroupedBackground)
    static let rcSeparator = Color(uiColor: .separator)
    static let rcTrack = Color(uiColor: .systemFill)

    static let rcTextPrimary = Color(uiColor: .label)
    static let rcTextSecondary = Color(uiColor: .secondaryLabel)
    static let rcTextTertiary = Color(uiColor: .tertiaryLabel)

    static let rcSuccess = Color(uiColor: .dynamic(light: 0x1E8E5A, dark: 0x4CD38C))
    static let rcWarning = Color(uiColor: .dynamic(light: 0xA85F00, dark: 0xFFB340))
    static let rcDanger = Color(uiColor: .dynamic(light: 0xC62828, dark: 0xFF6B6B))
    static let rcInfo = Color(uiColor: .dynamic(light: 0x1565C0, dark: 0x64B5F6))

    /// Ring and bar color for a display score (0–100, multiples of 5); gray when there is no number.
    static func rcScore(_ score: Int?) -> Color {
        guard let score else { return .rcTextTertiary }
        switch score {
        case ..<50: return .rcDanger
        case ..<70: return .rcWarning
        default: return .rcSuccess
        }
    }
}

extension UIColor {
    /// A color with separate light and dark values (sRGB hex).
    static func dynamic(light: UInt32, dark: UInt32) -> UIColor {
        UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        }
    }

    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

extension Font {
    /// Screen titles (rounded, bold), scales with Dynamic Type.
    static let rcDisplay = Font.system(.largeTitle, design: .rounded, weight: .bold)
    static let rcTitle = Font.system(.title2, design: .rounded, weight: .bold)
    static let rcTitle3 = Font.system(.title3, design: .rounded, weight: .semibold)
    static let rcHeadline = Font.system(.headline, design: .rounded)
    static let rcBody = Font.body
    static let rcCallout = Font.callout
    static let rcSubheadline = Font.subheadline
    static let rcFootnote = Font.footnote
    static let rcCaption = Font.caption
    /// Big score numbers (tabular digits).
    static let rcScore = Font.system(.largeTitle, design: .rounded, weight: .heavy).monospacedDigit()
}
