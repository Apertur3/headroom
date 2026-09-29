import Foundation
import CodexBarCore

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
    static let fiveHourMinutes = 300
    static let weeklyMinutes = 10_080
    static let expectedMeters: Set<String> = ["gemini", "claude-gpt"]

    /// Antigravity classifies a window by its duration/identity, not by
    /// whether this particular poll happened to carry a `resetsAt`: the
    /// vendor's rolling five-hour lane can go idle and stop reporting a
    /// reset while still being the same 300-minute window, and a
    /// `resetsAt == nil ? "rolling" : "fixed"` heuristic flips "kind"
    /// poll-to-poll for that same window. That flip trips the store's
    /// two-poll `vendor_window_held` guard (same window compared via
    /// `kind`/`minutes`/`enforcement`) purely from a classification bug, not
    /// a real vendor change -- issue #55's second path. This mirrors
    /// `src/adapters/antigravity.ts`'s static `WINDOWS` table (5h ->
    /// rolling, weekly -> fixed) rather than re-deriving kind from the
    /// payload each time. Unrecognized durations (never seen from AGY) fall
    /// back to the previous resetsAt-based heuristic.
    static func kind(for window: RateWindow) -> String {
        switch window.windowMinutes {
        case fiveHourMinutes: return "rolling"
        case weeklyMinutes: return "fixed"
        default: return window.resetsAt == nil ? "rolling" : "fixed"
        }
    }

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
