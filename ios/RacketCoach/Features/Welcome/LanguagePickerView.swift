import CoachCore
import SwiftUI

/// In-app language picker (DESIGN.md D15): System / Tiếng Việt / English. "System" means Vietnamese when the
/// storefront or region is Vietnam, otherwise the iOS language. System sheets (camera permission, purchases) always
/// follow the iOS language. Used from Welcome and Settings.
struct LanguagePickerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    ForEach(AppLanguage.allCases) { option in
                        RCOptionRow(
                            title: Text(verbatim: Self.displayName(of: option, resolved: model.resolvedLanguage)),
                            isSelected: model.language == option
                        ) {
                            model.setLanguage(option)
                            dismiss()
                        }
                    }
                    Text("language.system_sheets_note")
                        .font(.rcFootnote)
                        .foregroundStyle(Color.rcTextSecondary)
                        .padding(.top, DS.Spacing.xs)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(DS.Spacing.m)
            }
            .background(Color.rcBackground)
            .navigationTitle(Text("language.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("common.close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// "Tiếng Việt" and "English" are always written in their own language (as iOS does); "System" is localized and
    /// shows what it resolves to, e.g. "Theo hệ thống (Tiếng Việt)".
    static func displayName(of option: AppLanguage, resolved: Language) -> String {
        switch option {
        case .vi: return "Tiếng Việt"
        case .en: return "English"
        case .system:
            let current = resolved == .vi ? "Tiếng Việt" : "English"
            return L10n.format("language.system_with_current", current, language: resolved)
        }
    }
}

#Preview {
    LanguagePickerView()
        .environment(AppModel.preview())
}
