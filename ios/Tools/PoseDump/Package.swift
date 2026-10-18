// swift-tools-version: 6.0
// PoseDump: macOS command-line tool that turns a video file into a pose.v1 fixture using the same CoachCore logic as
// the app (DESIGN.md §5.3). Build and run on a Mac: `swift run -c release posedump clip.mov --skill bd.clear_fh`.
import PackageDescription

let package = Package(
    name: "PoseDump",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "posedump", targets: ["PoseDump"]),
    ],
    dependencies: [
        .package(path: "../../Packages/CoachCore"),
    ],
    targets: [
        .executableTarget(
            name: "PoseDump",
            dependencies: [.product(name: "CoachCore", package: "CoachCore")],
            // AVFoundation / Vision types are not Sendable; the tool is single-threaded, so Swift 5 mode is enough.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
