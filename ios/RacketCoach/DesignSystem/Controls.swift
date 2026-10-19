import SwiftUI

/// Square checkbox for consent items: nothing is pre-ticked, the whole row is tappable, VoiceOver reads it as a toggle.
struct RCCheckboxToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
                Image(systemName: configuration.isOn ? "checkmark.square.fill" : "square")
                    .font(.title3)
                    .foregroundStyle(configuration.isOn ? Color.rcAccent : Color.rcTextSecondary)
                    .accessibilityHidden(true)
                configuration.label
                    .font(.rcCallout)
                    .foregroundStyle(Color.rcTextPrimary)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(minHeight: DS.minTapHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityRepresentation {
            Toggle(isOn: configuration.$isOn) { configuration.label }
        }
    }
}

extension ToggleStyle where Self == RCCheckboxToggleStyle {
    static var rcCheckbox: RCCheckboxToggleStyle { RCCheckboxToggleStyle() }
}

/// A selectable option row (single choice lists such as level or language).
struct RCOptionRow: View {
    let title: Text
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                title
                    .font(.rcBody)
                    .foregroundStyle(Color.rcTextPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.rcAccent)
                }
            }
            .padding(.horizontal, DS.Spacing.m)
            .frame(minHeight: DS.minTapHeight)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous)
                    .fill(isSelected ? Color.rcAccentSoft : Color.rcSurface)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
