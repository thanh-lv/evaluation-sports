import CoachCore
import SwiftUI

/// Home (DESIGN.md §2.2 step 3): "Phân tích cú đánh", the quota chip from `my_status()`, the last result, the camera
/// guide and the sample analysis. History and Settings are in the toolbar.
struct HomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                if let banner = model.banner {
                    RCBannerView(banner: banner) { model.banner = nil }
                }
                header
                analyzeCard
                connectionNotice
                LastResultCard()
                learnSection
                if model.isPaid {
                    progressRow
                }
            }
            .padding(DS.Spacing.m)
        }
        .background(Color.rcBackground)
        .navigationTitle(Text(verbatim: "RacketCoach"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    model.navigate(to: .history)
                } label: {
                    Label("home.history", systemImage: "clock.arrow.circlepath")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    model.navigate(to: .settings)
                } label: {
                    Label("home.settings", systemImage: "gearshape")
                }
            }
        }
        .refreshable {
            await model.refreshAll()
            await model.refreshLatestLocalResult()
        }
        .task {
            await model.refreshLatestLocalResult()
        }
    }

    // MARK: Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.xs) {
            Text("home.title")
                .font(.rcDisplay)
                .accessibilityAddTraits(.isHeader)
            if let summary = QuotaSummary.make(status: model.status, language: model.resolvedLanguage) {
                HStack(spacing: DS.Spacing.xs) {
                    RCChip(verbatim: summary.text, systemImage: "bolt.fill", tone: summary.tone.chipTone)
                    if summary.showsBonus {
                        RCChip("home.quota.bonus", systemImage: "sparkles", tone: .accent)
                    }
                }
            } else if model.isSignedIn {
                RCChip("home.quota.loading", tone: .neutral)
                    .redacted(reason: .placeholder)
            }
        }
    }

    private var analyzeCard: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text("home.analyze.subtitle")
                .font(.rcSubheadline)
                .foregroundStyle(Color.rcTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                model.startNewAnalysis()
            } label: {
                Label("home.analyze", systemImage: "video.badge.plus")
            }
            .buttonStyle(.rcPrimary)
        }
        .rcCard()
    }

    @ViewBuilder
    private var connectionNotice: some View {
        switch model.authState {
        case .failed(let error):
            HStack(alignment: .top, spacing: DS.Spacing.s) {
                Image(systemName: error == .notConfigured ? "wrench.and.screwdriver" : "wifi.slash")
                    .foregroundStyle(Color.rcWarning)
                    .accessibilityHidden(true)
                Text(error == .notConfigured ? LocalizedStringKey("home.not_configured") : LocalizedStringKey("home.offline"))
                    .font(.rcSubheadline)
                    .foregroundStyle(Color.rcTextSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .rcCard()
        default:
            EmptyView()
        }
    }

    private var learnSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            RCSectionHeader("home.learn.title")
            HomeLinkRow(systemImage: "camera.viewfinder", title: "home.camera_guide", subtitle: "home.camera_guide.subtitle") {
                model.navigate(to: .cameraGuide(sport: nil))
            }
            HomeLinkRow(systemImage: "play.rectangle", title: "home.sample", subtitle: "home.sample.subtitle") {
                model.navigate(to: .sampleAnalysis)
            }
            if model.isAnonymous && model.latestLocalResult != nil {
                HomeLinkRow(systemImage: "icloud.and.arrow.up", title: "home.save_history", subtitle: "home.save_history.subtitle") {
                    model.sheet = .accountLink
                }
            }
        }
    }

    private var progressRow: some View {
        HomeLinkRow(systemImage: "chart.line.uptrend.xyaxis", title: "home.progress", subtitle: "home.progress.subtitle") {
            model.navigate(to: .progress)
        }
    }
}

/// A tappable row with icon, title and subtitle (String Catalog keys).
struct HomeLinkRow: View {
    let systemImage: String
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: DS.Spacing.s) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .foregroundStyle(Color.rcAccent)
                    .frame(width: 32)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.rcHeadline)
                        .foregroundStyle(Color.rcTextPrimary)
                    Text(subtitle)
                        .font(.rcFootnote)
                        .foregroundStyle(Color.rcTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.rcTextTertiary)
                    .accessibilityHidden(true)
            }
            .rcCard(padding: DS.Spacing.s)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

extension QuotaSummary.Tone {
    var chipTone: RCChip.Tone {
        switch self {
        case .normal: return .accent
        case .low: return .warning
        case .empty: return .danger
        }
    }
}

#Preview("Free, 1 left") {
    NavigationStack { HomeView() }
        .environment(AppModel.preview(tier: .free, remaining: 1))
}

#Preview("Premium at cap") {
    NavigationStack { HomeView() }
        .environment(AppModel.preview(tier: .premium, remaining: 0))
}
