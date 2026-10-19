import CoachCore
import SwiftUI

/// "Về bạn" (DESIGN.md §2.2 step 2, D21): birth year with a neutral picker (nothing pre-selected), the 18+ gate from
/// `app_config.min_user_age` with an attestation when the year is exactly at the threshold, handedness, and an
/// optional level. Under the minimum age the user is stopped with a polite message and nothing is stored.
struct AboutYouView: View {
    @Environment(AppModel.self) private var model

    @State private var birthYear: Int?
    @State private var ageAttested = false
    @State private var handedness: Handedness?
    @State private var level: Level?
    @State private var isSaving = false

    private var minimumAge: Int { model.appConfig.minUserAge }
    private var currentYear: Int { AgeGate.currentYear(now: model.deps.clock.now()) }

    private var verdict: AgeGate.Verdict? {
        birthYear.map { AgeGate.evaluate(birthYear: $0, currentYear: currentYear, minimumAge: minimumAge) }
    }

    private var canContinue: Bool {
        guard handedness != nil, !isSaving else { return false }
        switch verdict {
        case .allowed: return true
        case .needsAttestation: return ageAttested
        case .blocked, .none: return false
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                VStack(alignment: .leading, spacing: DS.Spacing.xs) {
                    Text("about.title")
                        .font(.rcDisplay)
                        .accessibilityAddTraits(.isHeader)
                    Text("about.subtitle")
                        .font(.rcBody)
                        .foregroundStyle(Color.rcTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                birthYearSection
                handednessSection
                levelSection
            }
            .padding(DS.Spacing.m)
        }
        .background(Color.rcBackground)
        .safeAreaInset(edge: .bottom) {
            Button {
                save()
            } label: {
                if isSaving {
                    ProgressView().tint(Color.rcOnAccent)
                } else {
                    Text("about.continue")
                }
            }
            .buttonStyle(.rcPrimary)
            .disabled(!canContinue)
            .padding(.horizontal, DS.Spacing.m)
            .padding(.vertical, DS.Spacing.s)
            .background(.bar)
        }
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: birthYear) { _, _ in
            ageAttested = false
        }
        .onAppear {
            let saved = model.onboarding
            if birthYear == nil { birthYear = saved.birthYear }
            if handedness == nil { handedness = saved.handedness }
            if level == nil { level = saved.level }
        }
    }

    // MARK: Sections

    private var birthYearSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text("about.birth_year.title")
                .font(.rcHeadline)
            Picker(selection: $birthYear) {
                Text("about.birth_year.placeholder").tag(Int?.none)
                ForEach(AgeGate.selectableYears(currentYear: currentYear), id: \.self) { year in
                    Text(verbatim: String(year)).tag(Int?.some(year))
                }
            } label: {
                Text("about.birth_year.title")
            }
            .pickerStyle(.wheel)
            .frame(maxHeight: 160)
            .clipped()
            Text("about.birth_year.why")
                .font(.rcFootnote)
                .foregroundStyle(Color.rcTextSecondary)
                .fixedSize(horizontal: false, vertical: true)

            switch verdict {
            case .blocked:
                Label {
                    Text(verbatim: L10n.format("about.age.blocked", minimumAge, language: model.resolvedLanguage))
                } icon: {
                    Image(systemName: "hand.raised.fill")
                }
                .font(.rcCallout)
                .foregroundStyle(Color.rcWarning)
                .fixedSize(horizontal: false, vertical: true)
            case .needsAttestation:
                Toggle(isOn: $ageAttested) {
                    Text(verbatim: L10n.format("about.age.attest", minimumAge, language: model.resolvedLanguage))
                }
                .toggleStyle(.rcCheckbox)
            case .allowed, .none:
                EmptyView()
            }
        }
        .rcCard()
    }

    private var handednessSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text("about.handedness.title")
                .font(.rcHeadline)
            Picker(selection: $handedness) {
                Text("handedness.right").tag(Handedness?.some(.right))
                Text("handedness.left").tag(Handedness?.some(.left))
            } label: {
                Text("about.handedness.title")
            }
            .pickerStyle(.segmented)
            Text("about.handedness.hint")
                .font(.rcFootnote)
                .foregroundStyle(Color.rcTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .rcCard()
    }

    private var levelSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            HStack(alignment: .firstTextBaseline) {
                Text("about.level.title")
                    .font(.rcHeadline)
                Spacer()
                Text("common.optional")
                    .font(.rcFootnote)
                    .foregroundStyle(Color.rcTextSecondary)
            }
            ForEach(Level.allCases, id: \.self) { option in
                RCOptionRow(title: Text(LevelText.key(option)), isSelected: level == option) {
                    level = (level == option) ? nil : option
                }
            }
            Text("about.level.hint")
                .font(.rcFootnote)
                .foregroundStyle(Color.rcTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .rcCard()
    }

    // MARK: Actions

    private func save() {
        guard canContinue, let birthYear, let handedness else { return }
        isSaving = true
        let attested = verdict == .needsAttestation ? ageAttested : false
        let level = level
        Task {
            await model.completeOnboarding(birthYear: birthYear, ageAttested: attested, handedness: handedness, level: level)
            isSaving = false
        }
    }
}

/// String Catalog keys of the player levels (§10.2: Mới bắt đầu / Đang tiến bộ / Trung cấp / Nâng cao). Shared by
/// About you, Settings › Profile and the result level label.
enum LevelText {
    static func key(_ level: Level) -> LocalizedStringKey {
        switch level {
        case .beginner: return "level.beginner"
        case .improving: return "level.improving"
        case .intermediate: return "level.intermediate"
        case .advanced: return "level.advanced"
        }
    }

    /// The same text outside views.
    static func string(_ level: Level, language: Language? = nil) -> String {
        L10n.string("level.\(level.rawValue)", language: language)
    }
}

#Preview {
    NavigationStack {
        AboutYouView()
    }
    .environment(AppModel.preview(onboarded: false))
}
