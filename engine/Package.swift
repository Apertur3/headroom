// swift-tools-version: 6.0
import PackageDescription

// Pinned to the same release as engine.lock.json's CodexBarCLI assets, so the
// Swift engine and the downloaded CLI stay on one upstream version. This is a
// real network dependency: building this package fetches source from GitHub.
//
// Pinned by commit (the exact commit the "v0.56.4" tag points to) rather than
// `exact: "0.56.4"`: CodexBar itself depends on an unstable (revision-pinned)
// package, and SwiftPM refuses to resolve a stable-version dependency (exact/
// from) whose own dependency graph contains an unstable one. A revision pin
// is treated as unstable too, so resolution succeeds; it is exactly as fixed
// a reference as a tag.
let codexBar: Package.Dependency = .package(url: "https://github.com/steipete/codexbar", revision: "fb9d295304af2873803b317ac1e3adb07b414083")

let package = Package(
    name: "HeadroomEngine",
    platforms: [.macOS(.v14)],
    dependencies: [codexBar],
    targets: [
        .executableTarget(
            name: "headroom-engine",
            dependencies: [.product(name: "CodexBarCore", package: "codexbar")],
            path: "Sources/HeadroomEngine",
            linkerSettings: []),
        .executableTarget(
            name: "headroom-claude-probe",
            path: "Sources/HeadroomClaudeProbe",
            linkerSettings: [.linkedFramework("Security")]),
        .testTarget(
            name: "HeadroomEngineTests",
            dependencies: ["headroom-engine", .product(name: "CodexBarCore", package: "codexbar")],
            path: "Tests/HeadroomEngineTests"),
        .testTarget(
            name: "HeadroomClaudeProbeTests",
            dependencies: ["headroom-claude-probe"],
            path: "Tests/HeadroomClaudeProbeTests")
    ])
