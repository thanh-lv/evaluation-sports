import CoachCore
import SwiftUI

/// First screen (DESIGN.md §2.2 step 1): language pre-selected by storefront or region with a picker link, three
/// value cards, "Bắt đầu" and "Xem phân tích mẫu". The anonymous sign-in runs silently in the background.
struct WelcomeView: View {
    var onStart: () -> Void
    var onSample: () -> Void

    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                hero
                VStack(spacing: DS.Spacing.s) {
                    RCFeatureRow(systemImage: "scope", title: "welcome.card.fix.title", message: "welcome.card.fix.body")
                        .rcCard()
                    RCFeatureRow(systemImage: "lock.iphone", title: "welcome.card.privacy.title", message: "welcome.card.privacy.body")
                        .rcCard()
                    RCFeatureRow(systemImage: "figure.badminton", title: "welcome.card.sports.title", message: "welcome.card.sports.body")
                        .rcCard()
                }
                languageRow
            }
            .padding(DS.Spacing.m)
        }
        .background(Color.rcBackground)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: DS.Spacing.xs) {
                Button("welcome.start", action: onStart)
                    .buttonStyle(.rcPrimary)
                Button("welcome.sample", action: onSample)
                    .buttonStyle(.rcSecondary)
                Text("welcome.ai_note")
                    .font(.rcCaption)
                    .foregroundStyle(Color.rcTextSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, DS.Spacing.m)
            .padding(.vertical, DS.Spacing.s)
            .background(.bar)
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Image(systemName: "figure.tennis")
                .font(.system(size: 44, weight: .semibold))
                .foregroundStyle(Color.rcAccent)
                .accessibilityHidden(true)
            Text(verbatim: "RacketCoach")
                .font(.rcDisplay)
                .foregroundStyle(Color.rcTextPrimary)
                .accessibilityAddTraits(.isHeader)
            Text("welcome.subtitle")
                .font(.rcTitle3)
                .foregroundStyle(Color.rcTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, DS.Spacing.l)
    }

    private var languageRow: some View {
        Button {
            model.sheet = .languagePicker
        } label: {
            HStack(spacing: DS.Spacing.xs) {
                Image(systemName: "globe")
                    .accessibilityHidden(true)
                Text("welcome.language")
                Text(verbatim: LanguagePickerView.displayName(of: model.language, resolved: model.resolvedLanguage))
                    .fontWeight(.semibold)
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .accessibilityHidden(true)
            }
            .font(.rcCallout)
            .foregroundStyle(Color.rcAccent)
            .frame(minHeight: DS.minTapHeight)
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
    }
}

#Preview {
    NavigationStack {
        WelcomeView(onStart: {}, onSample: {})
    }
    .environment(AppModel.preview(onboarded: false))
}
