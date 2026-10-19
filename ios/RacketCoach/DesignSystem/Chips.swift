import SwiftUI

/// Small capsule label: quota ("Còn 1/2 lượt tháng này"), "beta", evidence, status.
struct RCChip: View {
    enum Tone: Sendable {
        case neutral
        case accent
        case success
        case warning
        case danger

        var foreground: Color {
            switch self {
            case .neutral: return .rcTextSecondary
            case .accent: return .rcAccent
            case .success: return .rcSuccess
            case .warning: return .rcWarning
            case .danger: return .rcDanger
            }
        }

        var background: Color {
            switch self {
            case .neutral: return .rcTrack
            case .accent: return .rcAccentSoft
            default: return foreground.opacity(0.14)
            }
        }
    }

    private let text: Text
    var systemImage: String?
    var tone: Tone

    /// A chip from a String Catalog key.
    init(_ key: LocalizedStringKey, systemImage: String? = nil, tone: Tone = .neutral) {
        text = Text(key)
        self.systemImage = systemImage
        self.tone = tone
    }

    /// A chip from text that is already localized (e.g. `L10n.format`, server copy).
    init(verbatim: String, systemImage: String? = nil, tone: Tone = .neutral) {
        text = Text(verbatim: verbatim)
        self.systemImage = systemImage
        self.tone = tone
    }

    var body: some View {
        HStack(spacing: DS.Spacing.xxs) {
            if let systemImage {
                Image(systemName: systemImage)
                    .imageScale(.small)
                    .accessibilityHidden(true)
            }
            text
                .lineLimit(2)
                .multilineTextAlignment(.leading)
        }
        .font(.rcFootnote.weight(.semibold))
        .foregroundStyle(tone.foreground)
        .padding(.horizontal, DS.Spacing.s)
        .padding(.vertical, 6)
        .background(Capsule().fill(tone.background))
        .accessibilityElement(children: .combine)
    }
}

/// The "beta" label next to every score (DESIGN.md D3).
struct RCBetaBadge: View {
    var body: some View {
        RCChip("common.beta", tone: .accent)
    }
}
