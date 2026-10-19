import SwiftUI

/// Centered spinner with a message.
struct RCLoadingView: View {
    var message: LocalizedStringKey = "common.loading"

    var body: some View {
        VStack(spacing: DS.Spacing.s) {
            ProgressView()
            Text(message)
                .font(.rcSubheadline)
                .foregroundStyle(Color.rcTextSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(DS.Spacing.l)
    }
}

/// An error with an optional retry button. `message` is already localized (`AppError.localizedMessage`).
struct RCErrorView: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: DS.Spacing.m) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(Color.rcWarning)
                .accessibilityHidden(true)
            Text(verbatim: message)
                .font(.rcBody)
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.rcTextPrimary)
            if let retry {
                Button("common.retry", action: retry)
                    .buttonStyle(.rcSecondary)
                    .frame(maxWidth: 240)
            }
        }
        .padding(DS.Spacing.l)
        .frame(maxWidth: .infinity)
    }
}

/// Inline banner (`AppModel.banner`) with a close button.
struct RCBannerView: View {
    let banner: AppBanner
    var onClose: () -> Void

    private var tint: Color {
        switch banner.tone {
        case .info: return .rcInfo
        case .warning: return .rcWarning
        case .error: return .rcDanger
        }
    }

    private var icon: String {
        switch banner.tone {
        case .info: return "info.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: DS.Spacing.s) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(verbatim: banner.message)
                .font(.rcSubheadline)
                .foregroundStyle(Color.rcTextPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.rcTextSecondary)
                    .frame(width: DS.minTapHeight, height: DS.minTapHeight)
            }
            .accessibilityLabel(Text("common.close"))
            .padding(-DS.Spacing.s)
        }
        .padding(DS.Spacing.m)
        .background(RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous).fill(tint.opacity(0.12)))
    }
}

/// Placeholder for a screen that another milestone fills in (shown only in development builds).
struct RCPlaceholderView: View {
    let title: LocalizedStringKey

    var body: some View {
        VStack(spacing: DS.Spacing.m) {
            Image(systemName: "hammer")
                .font(.largeTitle)
                .foregroundStyle(Color.rcTextTertiary)
                .accessibilityHidden(true)
            Text(title)
                .font(.rcTitle3)
            Text("common.coming_soon")
                .font(.rcSubheadline)
                .foregroundStyle(Color.rcTextSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.rcBackground)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
