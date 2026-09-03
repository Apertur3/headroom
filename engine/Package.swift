// swift-tools-version: 6.0
import PackageDescription

let codexBarTag = "v0.56.4"
// Offline development uses the unpacked, pinned checkout. Release builds change only this
// line to: .package(url: "https://github.com/steipete/codexbar", exact: codexBarTag)
let codexBar: Package.Dependency = .package(
    path: "/private/tmp/claude-501/-Users-you/32cd283c-3538-4728-bb8e-5a7047cc2490/scratchpad/codexbar")

let package = Package(
    name: "HeadroomEngine",
    platforms: [.macOS(.v14)],
    dependencies: [codexBar],
    targets: [
        .executableTarget(
            name: "headroom-engine",
            dependencies: [.product(name: "CodexBarCore", package: "codexbar")],
            path: "Sources/HeadroomEngine",
            linkerSettings: [.linkedFramework("Security")]),
        .executableTarget(
            name: "headroom-keychain",
            path: "Sources/HeadroomKeychain",
            linkerSettings: [.linkedFramework("Security")]),
        .testTarget(
            name: "HeadroomEngineTests",
            dependencies: ["headroom-engine"],
            path: "Tests/HeadroomEngineTests")
    ])
