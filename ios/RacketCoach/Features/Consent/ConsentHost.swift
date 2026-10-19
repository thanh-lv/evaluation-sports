import SwiftUI

/// Presents the just-in-time consent sheet when `AppModel.ensureConsent()` asks for it (DESIGN.md §2.2 step 5).
/// `RootView` applies it; a flow presented in a full-screen cover applies it too, and the most recently shown host
/// presents the sheet so it always appears on top.
struct ConsentHostModifier: ViewModifier {
    @Environment(AppModel.self) private var model
    @State private var hostId = UUID()

    func body(content: Content) -> some View {
        content
            .onAppear { model.registerConsentHost(hostId) }
            .onDisappear { model.unregisterConsentHost(hostId) }
            .sheet(item: requestBinding) { request in
                ConsentSheet(request: request)
                    .environment(model)
                    .environment(\.locale, model.resolvedLanguage.locale)
                    .interactiveDismissDisabled()
            }
    }

    private var requestBinding: Binding<AppModel.ConsentRequest?> {
        Binding(
            get: { model.consentHosts.last == hostId ? model.consentRequest : nil },
            set: { newValue in
                // Dismissed without an answer (should not happen: swipe-to-dismiss is disabled) counts as "Not now".
                if newValue == nil, model.consentRequest != nil, model.consentHosts.last == hostId {
                    model.declineConsent()
                }
            }
        )
    }
}

extension View {
    /// Lets this view present the consent sheet (see `ConsentHostModifier`).
    func consentHost() -> some View {
        modifier(ConsentHostModifier())
    }
}
