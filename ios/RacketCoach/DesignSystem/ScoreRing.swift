import SwiftUI

/// Circular progress primitive for scores (0…1). `progress == nil` draws only the track ("Chưa đủ dữ liệu").
/// The Results feature composes the number, level label and beta chip in `center`.
struct ScoreRing<Center: View>: View {
    var progress: Double?
    var lineWidth: CGFloat = 12
    var tint: Color = .rcAccent
    @ViewBuilder var center: () -> Center

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.rcTrack, lineWidth: lineWidth)
            if let progress {
                Circle()
                    .trim(from: 0, to: min(max(progress, 0), 1))
                    .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            center()
                .padding(lineWidth)
        }
        .animation(.easeOut(duration: 0.6), value: progress)
        .accessibilityElement(children: .combine)
    }
}

extension ScoreRing where Center == EmptyView {
    init(progress: Double?, lineWidth: CGFloat = 12, tint: Color = .rcAccent) {
        self.init(progress: progress, lineWidth: lineWidth, tint: tint) { EmptyView() }
    }
}

/// Ring with a display score (0–100) in the middle; a dash when there is no number.
struct ScoreRingLabel: View {
    let displayScore: Int?
    var size: CGFloat = 120

    var body: some View {
        ScoreRing(progress: displayScore.map { Double($0) / 100 }, lineWidth: max(size / 12, 6), tint: .rcScore(displayScore)) {
            Text(verbatim: displayScore.map { String($0) } ?? "–")
                .font(size >= 100 ? Font.rcScore : Font.rcHeadline.monospacedDigit())
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .foregroundStyle(Color.rcTextPrimary)
        }
        .frame(width: size, height: size)
    }
}
