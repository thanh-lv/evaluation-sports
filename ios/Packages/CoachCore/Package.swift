// swift-tools-version: 6.0
// CoachCore: deterministic, Foundation-only logic shared by the iOS app and the PoseDump tool (DESIGN.md §5.3).
// It must also build on Linux (swift-corelibs-foundation), so no Apple-only frameworks here.
import PackageDescription

let package = Package(
    name: "CoachCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CoachCore", targets: ["CoachCore"]),
    ],
    targets: [
        .target(name: "CoachCore"),
        .testTarget(name: "CoachCoreTests", dependencies: ["CoachCore"]),
    ]
)
