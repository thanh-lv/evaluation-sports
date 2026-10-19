import CoachCore
import SwiftUI

/// The blocking, versioned consent screen shown before the first submit and whenever a consent version changes
/// (DESIGN.md §2.2 step 5, §11; exact texts in docs/legal/consent-texts.{vi,en}.md). Nothing is pre-ticked;
/// "Agree and continue" is enabled only when (a) and (b) are ticked. (c) and (d) are optional toggles, off unless the
/// user turned them on before.
struct ConsentSheet: View {
    let request: AppModel.ConsentRequest

    @Environment(AppModel.self) private var model
    @State private var pdplAccepted = false
    @State private var aiAccepted = false
    @State private var calibrationOptIn: Bool
    @State private var consumptionConsent: Bool
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(request: AppModel.ConsentRequest) {
        self.request = request
        _calibrationOptIn = State(initialValue: request.calibrationOptIn)
        _consumptionConsent = State(initialValue: request.consumptionConsent)
    }

    private var canAccept: Bool { pdplAccepted && aiAccepted && !isSaving }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: DS.Spacing.l) {
                    header
                    ConsentSection(titleKey: "consent.pdpl.title", bodyKey: "consent.pdpl.body") {
                        Toggle(isOn: $pdplAccepted) { Text("consent.pdpl.checkbox") }
                            .toggleStyle(.rcCheckbox)
                    }
                    ConsentSection(titleKey: "consent.ai.title", bodyKey: "consent.ai.body") {
                        Toggle(isOn: $aiAccepted) { Text("consent.ai.checkbox") }
                            .toggleStyle(.rcCheckbox)
                    }
                    ConsentSection(titleKey: "consent.calibration.title", bodyKey: "consent.calibration.body") {
                        Toggle(isOn: $calibrationOptIn) { Text("consent.calibration.toggle") }
                            .font(.rcCallout)
                    }
                    ConsentSection(titleKey: "consent.consumption.title", bodyKey: "consent.consumption.body") {
                        Toggle(isOn: $consumptionConsent) { Text("consent.consumption.toggle") }
                            .font(.rcCallout)
                    }
                    links
                }
                .padding(DS.Spacing.m)
            }
            .background(Color.rcBackground)
            .safeAreaInset(edge: .bottom) { footer }
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.xs) {
            Text(request.isReconsent ? LocalizedStringKey("consent.reconsent.title") : LocalizedStringKey("consent.title"))
                .font(.rcTitle)
                .accessibilityAddTraits(.isHeader)
            Text(request.isReconsent ? LocalizedStringKey("consent.reconsent.intro") : LocalizedStringKey("consent.intro"))
                .font(.rcBody)
                .foregroundStyle(Color.rcTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var links: some View {
        let language = model.resolvedLanguage
        HStack(spacing: DS.Spacing.l) {
            if let url = model.deps.links.privacyPolicy(language) {
                Link(destination: url) { Text("consent.link.privacy") }
            }
            if let url = model.deps.links.aiDisclosure(language) {
                Link(destination: url) { Text("consent.link.ai") }
            }
        }
        .font(.rcCallout.weight(.semibold))
    }

    private var footer: some View {
        VStack(spacing: DS.Spacing.xs) {
            if let errorMessage {
                Text(verbatim: errorMessage)
                    .font(.rcFootnote)
                    .foregroundStyle(Color.rcDanger)
                    .multilineTextAlignment(.center)
            } else if !(pdplAccepted && aiAccepted) {
                Text("consent.required_hint")
                    .font(.rcFootnote)
                    .foregroundStyle(Color.rcTextSecondary)
                    .multilineTextAlignment(.center)
            }
            Button {
                accept()
            } label: {
                if isSaving {
                    ProgressView().tint(Color.rcOnAccent)
                } else {
                    Text("consent.button.accept")
                }
            }
            .buttonStyle(.rcPrimary)
            .disabled(!canAccept)
            Button("consent.button.later") {
                model.declineConsent()
            }
            .buttonStyle(.rcTertiary)
            .disabled(isSaving)
        }
        .padding(.horizontal, DS.Spacing.m)
        .padding(.top, DS.Spacing.s)
        .padding(.bottom, DS.Spacing.xs)
        .background(.bar)
    }

    private func accept() {
        guard canAccept else { return }
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await model.acceptConsent(calibrationOptIn: calibrationOptIn, consumptionConsent: consumptionConsent)
            } catch {
                errorMessage = AppError.from(error).localizedMessage
            }
            isSaving = false
        }
    }
}

/// One consent item: title, full text, then its checkbox or toggle.
private struct ConsentSection<Control: View>: View {
    let titleKey: LocalizedStringKey
    let bodyKey: LocalizedStringKey
    @ViewBuilder var control: () -> Control

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text(titleKey)
                .font(.rcHeadline)
                .accessibilityAddTraits(.isHeader)
            Text(bodyKey)
                .font(.rcSubheadline)
                .foregroundStyle(Color.rcTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
            control()
        }
        .rcCard()
    }
}

#Preview {
    ConsentSheet(request: AppModel.ConsentRequest(
        isReconsent: false, pdplVersion: "2026-10-01", aiVersion: "2026-10-01",
        calibrationOptIn: false, consumptionConsent: false
    ))
    .environment(AppModel.preview())
}
