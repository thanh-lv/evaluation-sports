import SwiftUI

/// Rounded surface used for every content block (value cards, last result, hero fix, findings).
struct RCCardModifier: ViewModifier {
    var padding: CGFloat = DS.Spacing.m
    var fill: Color = .rcSurface

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous).fill(fill))
    }
}

extension View {
    /// Wraps the view in a card surface.
    func rcCard(padding: CGFloat = DS.Spacing.m, fill: Color = .rcSurface) -> some View {
        modifier(RCCardModifier(padding: padding, fill: fill))
    }
}

/// Title (and optional subtitle) above a group of cards. Takes String Catalog keys.
struct RCSectionHeader: View {
    let title: LocalizedStringKey
    var subtitle: LocalizedStringKey?

    init(_ title: LocalizedStringKey, subtitle: LocalizedStringKey? = nil) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.xxs) {
            Text(title)
                .font(.rcTitle3)
                .foregroundStyle(Color.rcTextPrimary)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle)
                    .font(.rcSubheadline)
                    .foregroundStyle(Color.rcTextSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// An icon + title + text row used by the value cards on Welcome and by explanatory lists.
struct RCFeatureRow: View {
    let systemImage: String
    let title: LocalizedStringKey
    let message: LocalizedStringKey

    var body: some View {
        HStack(alignment: .top, spacing: DS.Spacing.s) {
            Image(systemName: systemImage)
                .font(.title2)
                .foregroundStyle(Color.rcAccent)
                .frame(width: 36)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: DS.Spacing.xxs) {
                Text(title)
                    .font(.rcHeadline)
                    .foregroundStyle(Color.rcTextPrimary)
                Text(message)
                    .font(.rcSubheadline)
                    .foregroundStyle(Color.rcTextSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
