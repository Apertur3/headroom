import Foundation
import CodexBarCore

/// Cold `agy` starts bind their localhost HTTPS port well after the process is
/// visible. The Core's generic probe otherwise reports a misleading immediate
/// failure. This helper owns only the process it started and waits at most 30s.
enum AgyBootstrap {
    private static let attempts = 60
    private static let pollNanoseconds: UInt64 = 500_000_000

    static func fetch(binaryHint: String) async throws -> AntigravitySnapshotFetch {
        let binary = FileManager.default.isExecutableFile(atPath: binaryHint) ? binaryHint : "agy"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/script")
        process.arguments = ["-q", "/dev/null", binary]
        process.environment = ["HOME": NSHomeDirectory(), "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"]
        let sink = Pipe()
        process.standardOutput = sink
        process.standardError = sink
        try process.run()
        defer {
            // `script` closes the PTY when its root exits; this is intentionally
            // limited to the process tree launched above, never a user-owned agy.
            if process.isRunning { process.terminate() }
        }
        for _ in 0..<attempts {
            guard process.isRunning else { throw EngineError.noUsage }
            let ports = agyListeningPorts(rootPID: process.processIdentifier)
            if !ports.isEmpty {
                // A listening socket only proves that `agy` has bound a port. It
                // can still serve GetUserStatus's two five-hour rows before its
                // quota summary has populated the two weekly rows.
                return try await AntigravitySnapshotWaiter.wait(
                    timeout: 45,
                    pollNanoseconds: 1_500_000_000,
                    fetch: { remaining in
                        let status = try await AntigravityStatusProbe(timeout: min(8, remaining)).fetchFromPorts(ports)
                        return try AntigravitySnapshotFetch(status: status)
                    })
            }
            try await Task.sleep(nanoseconds: pollNanoseconds)
        }
        throw EngineError.noUsage
    }

    private static func agyListeningPorts(rootPID: Int32) -> [Int] {
        let pids = [rootPID] + descendantPIDs(of: rootPID)
        let lsof = Process()
        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.map(String.init).joined(separator: ",")]
        let output = Pipe()
        lsof.standardOutput = output
        lsof.standardError = Pipe()
        do { try lsof.run(); lsof.waitUntilExit() } catch { return [] }
        guard lsof.terminationStatus == 0,
              let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8),
              let expression = try? NSRegularExpression(pattern: #":(\d+)\s+\(LISTEN\)"#)
        else { return [] }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return expression.matches(in: text, range: range).compactMap { match in
            guard let portRange = Range(match.range(at: 1), in: text) else { return nil }
            return Int(text[portRange])
        }
    }

    private static func descendantPIDs(of root: Int32) -> [Int32] {
        var result: [Int32] = []
        var pending = [root]
        while let parent = pending.popLast() {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
            task.arguments = ["-P", String(parent)]
            let output = Pipe()
            task.standardOutput = output
            task.standardError = Pipe()
            guard (try? task.run()) != nil else { continue }
            task.waitUntilExit()
            let children = (String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "")
                .split(whereSeparator: \ .isNewline).compactMap { Int32($0) }
            result += children
            pending += children
        }
        return result
    }
}

/// Treat quota-summary cadence coverage as readiness. CodexBarCore's probe is
/// intentionally allowed to return a parseable fallback status while a fresh
/// `agy` is initializing, so this layer retains that useful snapshot but waits
/// for the richer per-group weekly summary before presenting it as complete.
struct AntigravitySnapshotFetch: Sendable {
    let usage: UsageSnapshot

    init(status: AntigravityStatusSnapshot) throws {
        self.usage = try status.toUsageSnapshot()
    }

    init(usage: UsageSnapshot) {
        self.usage = usage
    }
}

enum AntigravitySnapshotWaiter {
    static let weeklyMinutes = 10_080
    static let expectedMeters: Set<String> = ["gemini", "claude-gpt"]

    static func wait(
        timeout: TimeInterval,
        pollNanoseconds: UInt64,
        maximumAttempts: Int? = nil,
        fetch: @escaping (TimeInterval) async throws -> AntigravitySnapshotFetch,
        sleep: @escaping (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) async throws -> AntigravitySnapshotFetch
    {
        let deadline = Date().addingTimeInterval(timeout)
        var lastSnapshot: AntigravitySnapshotFetch?
        var lastError: Error?
        var attempts = 0

        while Date() <= deadline, maximumAttempts.map({ attempts < $0 }) ?? true {
            attempts += 1
            do {
                let remaining = deadline.timeIntervalSinceNow
                guard remaining > 0 else { break }
                let snapshot = try await fetch(remaining)
                lastSnapshot = snapshot
                if isReady(snapshot.usage) {
                    return snapshot
                }
            } catch {
                lastError = error
            }

            guard Date() < deadline,
                  maximumAttempts.map({ attempts < $0 }) ?? true
            else { break }
            try await sleep(pollNanoseconds)
        }

        if let lastSnapshot { return lastSnapshot }
        throw lastError ?? EngineError.noUsage
    }

    static func isReady(_ usage: UsageSnapshot) -> Bool {
        let weeklyMeters = Set(summaryWindows(in: usage)
            .filter { $0.window.windowMinutes == weeklyMinutes }
            .compactMap { meter(for: $0) })
        return weeklyMeters.isSuperset(of: expectedMeters)
    }

    static func summaryWindows(in usage: UsageSnapshot) -> [NamedRateWindow] {
        (usage.extraRateWindows ?? []).filter {
            AntigravityStatusSnapshot.isQuotaSummaryWindowID($0.id)
        }
    }

    static func meter(for window: NamedRateWindow) -> String? {
        let title = window.title.lowercased()
        if title.contains("gemini") { return "gemini" }
        if title.contains("claude") || title.contains("gpt") { return "claude-gpt" }
        return nil
    }
}
