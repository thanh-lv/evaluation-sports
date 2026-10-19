import SwiftUI

/// Filled accent button for the main action of a screen ("Bắt đầu", "Phân tích cú đánh").
struct RCPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.rcHeadline)
            .multilineTextAlignment(.center)
            .foregroundStyle(Color.rcOnAccent)
            .padding(.horizontal, DS.Spacing.m)
            .padding(.vertical, DS.Spacing.s)
            .frame(maxWidth: .infinity, minHeight: DS.primaryButtonHeight)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous)
                    .fill(Color.rcAccent.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.35))
            )
            .contentShape(RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous))
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// Tinted secondary button ("Xem phân tích mẫu").
struct RCSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.rcHeadline)
            .multilineTextAlignment(.center)
            .foregroundStyle(Color.rcAccent.opacity(isEnabled ? 1 : 0.4))
            .padding(.horizontal, DS.Spacing.m)
            .padding(.vertical, DS.Spacing.s)
            .frame(maxWidth: .infinity, minHeight: DS.primaryButtonHeight)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous)
                    .fill(Color.rcAccentSoft.opacity(configuration.isPressed ? 0.7 : 1))
            )
            .contentShape(RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous))
    }
}

/// Text-only button for low-emphasis actions ("Để sau", links).
struct RCTertiaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.rcCallout.weight(.semibold))
            .foregroundStyle(Color.rcAccent)
            .frame(minHeight: DS.minTapHeight)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == RCPrimaryButtonStyle {
    static var rcPrimary: RCPrimaryButtonStyle { RCPrimaryButtonStyle() }
}

extension ButtonStyle where Self == RCSecondaryButtonStyle {
    static var rcSecondary: RCSecondaryButtonStyle { RCSecondaryButtonStyle() }
}

extension ButtonStyle where Self == RCTertiaryButtonStyle {
    static var rcTertiary: RCTertiaryButtonStyle { RCTertiaryButtonStyle() }
}
