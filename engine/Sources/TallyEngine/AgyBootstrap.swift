import Foundation
import CodexBarCore

/// Cold `agy` starts bind their localhost HTTPS port well after the process is
/// visible. The Core's generic probe otherwise reports a misleading immediate
/// failure. This helper owns only the process it started and waits at most 30s.
enum AgyBootstrap {
    private static let attempts = 60
    private static let pollNanoseconds: UInt64 = 500_000_000

    static func fetch(binaryHint: String) async throws -> AntigravitySnapshotFetch {
        // Do not use the Core's broad `fetch()` here. That probe is deliberately
        // willing to attach to an app or IDE language server and accept its
        // GetUserStatus fallback. Tally needs the `agy` local quota-summary
        // endpoint specifically; an already-warm user-owned `agy` is preferable
        // to a second cold process as well.
        let existingPIDs = existingAgyPIDs()
        if !existingPIDs.isEmpty {
            return try await AntigravitySnapshotWaiter.wait(
                timeout: 15,
                pollNanoseconds: 1_500_000_000,
                fetch: { _ in try await fetchFromExistingAgy(pids: existingPIDs) })
        }
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
                        return try AntigravitySnapshotFetch(status: status, source: "local-agy-spawned")
                    })
            }
            try await Task.sleep(nanoseconds: pollNanoseconds)
        }
        throw EngineError.noUsage
    }

    private static func existingAgyPIDs() -> [Int32] {
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-ax", "-o", "pid=,command="]
        let output = Pipe()
        ps.standardOutput = output
        ps.standardError = Pipe()
        do { try ps.run(); ps.waitUntilExit() } catch { return [] }
        guard ps.terminationStatus == 0,
              let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
        else { return [] }

        return text.split(whereSeparator: \.isNewline).compactMap { line -> Int32? in
            let fields = line.split(maxSplits: 1, whereSeparator: \ .isWhitespace)
            guard fields.count == 2,
                  fields[1].range(of: #"(^|/)agy(?:\s|$)|antigravity[-_]cli"#, options: .regularExpression) != nil
            else { return nil }
            return Int32(fields[0])
        }
    }

    private static func fetchFromExistingAgy(pids: [Int32]) async throws -> AntigravitySnapshotFetch {
        var lastError: Error?
        for pid in pids {
            let ports = agyListeningPorts(rootPID: pid)
            guard !ports.isEmpty else { continue }
            do {
                let status = try await AntigravityStatusProbe(timeout: 2).fetchFromPorts(ports)
                return try AntigravitySnapshotFetch(status: status, source: "local-agy-existing")
            } catch {
                lastError = error
            }
        }
        throw lastError ?? EngineError.noUsage
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
    let source: String
    let fetchedAt: Date
    let payloadKind: PayloadKind

    enum PayloadKind: String, Sendable {
        /// CodexBarCore marks rows parsed from RetrieveUserQuotaSummary with
        /// this public quota-summary ID prefix.
        case retrieveUserQuotaSummary = "RetrieveUserQuotaSummary"
        /// GetUserStatus/GetCommandModelConfigs and OAuth's fetchAvailableModels
        /// normalize into ordinary model windows, never summary-window IDs.
        case availabilityOrFallback = "availability-or-fallback"
    }

    init(status: AntigravityStatusSnapshot, source: String) throws {
        self.usage = try status.toUsageSnapshot()
        self.source = source
        self.fetchedAt = Date()
        self.payloadKind = AntigravitySnapshotWaiter.summaryWindows(in: self.usage).isEmpty
            ? .availabilityOrFallback : .retrieveUserQuotaSummary
    }

    init(usage: UsageSnapshot, source: String = "fixture", fetchedAt: Date = Date()) {
        self.usage = usage
        self.source = source
        self.fetchedAt = fetchedAt
        self.payloadKind = AntigravitySnapshotWaiter.summaryWindows(in: usage).isEmpty
            ? .availabilityOrFallback : .retrieveUserQuotaSummary
    }
}

enum AntigravitySnapshotWaiter {
    static let weeklyMinutes = 10_080
    static let expectedMeters: Set<String> = ["gemini", "claude-gpt"]
    static let expectedMinutes: Set<Int> = [300, weeklyMinutes]

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
                if isReady(snapshot) {
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
        let lanes = Set(summaryWindows(in: usage).compactMap { row -> String? in
            guard row.usageKnown,
                  let meter = meter(for: row),
                  let minutes = row.window.windowMinutes,
                  expectedMinutes.contains(minutes)
            else { return nil }
            return "\(meter):\(minutes)"
        })
        let expected = Set(expectedMeters.flatMap { meter in
            expectedMinutes.map { "\(meter):\($0)" }
        })
        return lanes.isSuperset(of: expected)
    }

    static func isReady(_ snapshot: AntigravitySnapshotFetch) -> Bool {
        !isAvailabilityOnly(snapshot) && isReady(snapshot.usage)
    }

    /// CodexBarCore normalizes its true local summary into named rows whose IDs
    /// use `isQuotaSummaryWindowID`. Everything else is an availability/model
    /// fallback, including OAuth fetchAvailableModels. The second check catches
    /// a known placeholder that synthesizes resets at fetch+window duration.
    static func isAvailabilityOnly(_ snapshot: AntigravitySnapshotFetch) -> Bool {
        if snapshot.payloadKind == .availabilityOrFallback { return true }
        let windows = allWindows(in: snapshot.usage)
        guard !windows.isEmpty else { return true }
        if windows.allSatisfy({ $0.resetsAt == nil }) { return true }
        if windows.allSatisfy({ $0.usedPercent == 0 && resetDescriptionIsEmpty($0) }) { return true }
        return windows.allSatisfy { window in
            guard let minutes = window.windowMinutes, let reset = window.resetsAt,
                  window.usedPercent == 0 else { return false }
            return abs(reset.timeIntervalSince(snapshot.fetchedAt.addingTimeInterval(TimeInterval(minutes * 60)))) <= 90
        }
    }

    static func allWindows(in usage: UsageSnapshot) -> [RateWindow] {
        let named = summaryWindows(in: usage).map(\.window)
        return named.isEmpty
            ? [usage.primary, usage.secondary, usage.tertiary].compactMap(\.self)
            : named
    }

    static func resetDescriptionIsEmpty(_ window: RateWindow) -> Bool {
        window.resetDescription?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
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
