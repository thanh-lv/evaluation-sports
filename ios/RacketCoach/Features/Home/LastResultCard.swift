import CoachCore
import SwiftUI

/// Home's "last result" card: the newest analysis with a cached result on this iPhone (skill, date, score ring,
/// the #1 fix). Before any analysis it shows how to get started.
struct LastResultCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            RCSectionHeader("home.last_result.title")
            if let record = model.latestLocalResult {
                Button {
                    model.navigate(to: .result(analysisId: record.id))
                } label: {
                    content(record)
                }
                .buttonStyle(.plain)
            } else {
                emptyState
            }
        }
    }

    private func content(_ record: LocalAnalysisRecord) -> some View {
        HStack(alignment: .center, spacing: DS.Spacing.m) {
            ScoreRingLabel(displayScore: record.partial == true ? nil : record.displayScore, size: 64)
            VStack(alignment: .leading, spacing: DS.Spacing.xxs) {
                Text(verbatim: record.skill.map { model.skillName(id: $0) } ?? "—")
                    .font(.rcHeadline)
                    .foregroundStyle(Color.rcTextPrimary)
                Text(verbatim: L10nFormat.mediumDate(record.createdAt, language: model.resolvedLanguage))
                    .font(.rcFootnote)
                    .foregroundStyle(Color.rcTextSecondary)
                if record.partial == true {
                    Text("home.last_result.partial")
                        .font(.rcFootnote)
                        .foregroundStyle(Color.rcTextSecondary)
                } else if let hero = record.heroTitle, !hero.isEmpty {
                    Text(verbatim: L10n.format("home.last_result.fix_first", hero, language: model.resolvedLanguage))
                        .font(.rcSubheadline)
                        .foregroundStyle(Color.rcTextPrimary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.rcTextTertiary)
                .accessibilityHidden(true)
        }
        .rcCard()
        .contentShape(Rectangle())
    }

    private var emptyState: some View {
        HStack(alignment: .top, spacing: DS.Spacing.s) {
            Image(systemName: "figure.badminton")
                .font(.title2)
                .foregroundStyle(Color.rcAccent)
                .accessibilityHidden(true)
            Text("home.last_result.empty")
                .font(.rcSubheadline)
                .foregroundStyle(Color.rcTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .rcCard()
    }
}
