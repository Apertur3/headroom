import XCTest
import CodexBarCore
@testable import tally_engine

final class ClaudeKeychainReaderTests: XCTestCase {
    func testCanaryCredentialIsNeverIncludedInFailureOutput() throws {
        let canary = "canary-access-token-must-not-leak"
        let secret = "{\"claudeAiOauth\":{\"accessToken\":\"\(canary)\",\"refreshToken\":\"canary-refresh\",\"expiresAt\":4102444800000}}"
        let credentials = try ClaudeKeychainReader.parse(Data(secret.utf8))
        XCTAssertEqual(credentials.accessToken, canary)

        let output = try String(data: JSONEncoder().encode(TallyEngine.failed(
            principal: Principal(id: "claude-main", vendor: "claude", location: "/tmp/.claude"),
            meters: ["all"], error: EngineError.claudeUsageUnavailable)), encoding: .utf8)!
        XCTAssertFalse(output.contains(canary))
        XCTAssertFalse(output.contains("canary-refresh"))
    }

    func testScopedServiceUsesCanonicalConfigDirectory() {
        XCTAssertEqual(ClaudeKeychainReader.serviceName(configDirectory: "~/.claude"), "Claude Code-credentials")
        XCTAssertEqual(ClaudeKeychainReader.serviceName(configDirectory: "/Users/you/.claude2"), "Claude Code-credentials-c28c1f29")
        XCTAssertEqual(ClaudeKeychainReader.serviceName(configDirectory: "/tmp/.claude2/"), ClaudeKeychainReader.serviceName(configDirectory: "/tmp/.claude2"))
    }

    func testScopedLimitsMapFableAndInactiveRoutinesWithoutTrustingNullScope() throws {
        let response = """
        {
          "five_hour": {"utilization": 12, "resets_at": "2026-09-03T17:00:00Z"},
          "seven_day": {"utilization": 28, "resets_at": "2026-09-10T12:00:00Z"},
          "limits": [
            {"kind": "weekly_scoped", "is_active": true, "percent": 34, "resets_at": "2026-09-10T12:00:00Z", "scope": {"model": {"display_name": "Fable"}}},
            {"kind": "weekly_scoped", "is_active": false, "percent": 90, "resets_at": "2026-09-10T12:00:00Z", "scope": {"model": {"display_name": "Sonnet"}}},
            {"kind": "other", "is_active": true, "percent": 1, "scope": null}
          ]
        }
        """
        let snapshot = try ClaudeOAuthUsageReader.parse(Data(response.utf8))
        XCTAssertEqual(snapshot.fiveHour?.percent, 12)
        XCTAssertEqual(snapshot.sevenDay?.percent, 28)
        XCTAssertEqual(snapshot.fable?.percent, 34)
        XCTAssertTrue(snapshot.fable?.isEnforced == true)
        XCTAssertNil(snapshot.routines?.percent)
        XCTAssertFalse(snapshot.routines?.isEnforced ?? true)
        let principal = Principal(id: "claude-main", vendor: "claude", location: "/tmp/.claude")
        let observations = TallyEngine.claudeWindows(principal, meter: "fable", windows: [snapshot.fable])
            + TallyEngine.claudeWindows(principal, meter: "routines", windows: [snapshot.routines])
        XCTAssertTrue(observations.contains { $0.meter_id == "claude-main:fable" && $0.freshness == "fresh" })
        XCTAssertTrue(observations.contains { $0.meter_id == "claude-main:routines" && $0.freshness == "not_enforced" })
    }

    func testAbsentScopedLimitEmitsOneNotEnforcedWindow() throws {
        let response = """
        {"five_hour": {"utilization": 12}, "seven_day": {"utilization": 28}}
        """
        let snapshot = try ClaudeOAuthUsageReader.parse(Data(response.utf8))
        let principal = Principal(id: "claude-main", vendor: "claude", location: "/tmp/.claude")
        let observations = TallyEngine.claudeScopedWindows(principal, meter: "fable", window: snapshot.fable)
        XCTAssertEqual(observations.count, 1)
        XCTAssertEqual(observations.first?.meter_id, "claude-main:fable")
        XCTAssertEqual(observations.first?.freshness, "not_enforced")
        XCTAssertEqual(observations.first?.reason, "no scoped limit in response")
    }
}

final class AntigravityReadinessTests: XCTestCase {
    func testWaitsForQuotaSummaryThenEmitsBothWeeklyWindows() async throws {
        let sequence = SnapshotSequence([partialUsage(), completeUsage()])
        let fetched = try await AntigravitySnapshotWaiter.wait(
            timeout: 1,
            pollNanoseconds: 0,
            maximumAttempts: 2,
            fetch: { _ in await sequence.fetch() },
            sleep: { _ in })

        let fetchCount = await sequence.fetchCount()
        XCTAssertEqual(fetchCount, 2)
        XCTAssertTrue(AntigravitySnapshotWaiter.isReady(fetched.usage))
        let observations = TallyEngine.antigravityWindows(
            Principal(id: "antigravity-main", vendor: "antigravity", location: "agy"),
            usage: fetched.usage)
        XCTAssertEqual(observations.filter { $0.window?.minutes == 10_080 && $0.freshness == "fresh" }.count, 2)
        XCTAssertFalse(observations.contains { $0.freshness == "failed" })
    }

    func testIncompleteQuotaSummaryEmitsFailedWeeklyWindows() async throws {
        let sequence = SnapshotSequence([partialUsage(), partialUsage()])
        let fetched = try await AntigravitySnapshotWaiter.wait(
            timeout: 1,
            pollNanoseconds: 0,
            maximumAttempts: 2,
            fetch: { _ in await sequence.fetch() },
            sleep: { _ in })

        let fetchCount = await sequence.fetchCount()
        XCTAssertEqual(fetchCount, 2)
        XCTAssertFalse(AntigravitySnapshotWaiter.isReady(fetched.usage))
        let observations = TallyEngine.antigravityWindows(
            Principal(id: "antigravity-main", vendor: "antigravity", location: "agy"),
            usage: fetched.usage)
        let failedWeekly = observations.filter { $0.window?.minutes == 10_080 && $0.freshness == "failed" }
        XCTAssertEqual(Set(failedWeekly.map(\.meter_id)), ["antigravity-main:gemini", "antigravity-main:claude-gpt"])
        XCTAssertTrue(failedWeekly.allSatisfy { $0.reason == "quota summary not ready" })
    }

    func testShapeListsOnlyAntigravityWindowDescriptors() {
        let shape = TallyEngine.antigravityShape(completeUsage())
        XCTAssertEqual(shape[0], "$: object")
        XCTAssertTrue(shape.contains { $0.contains("title=Gemini weekly") && $0.contains("id=antigravity-quota-summary-gemini-weekly") && $0.contains("minutes=10080") && $0.contains("resets_at=present") })
        XCTAssertFalse(shape.joined(separator: " ").contains("usedPercent"))
    }

    private func partialUsage() -> UsageSnapshot {
        usage(includeWeekly: false)
    }

    private func completeUsage() -> UsageSnapshot {
        usage(includeWeekly: true)
    }

    private func usage(includeWeekly: Bool) -> UsageSnapshot {
        let reset = Date(timeIntervalSince1970: 1_800_000_000)
        let sessionRows = [
            NamedRateWindow(id: "antigravity-quota-summary-gemini-session", title: "Gemini 5-hour", window: RateWindow(usedPercent: 10, windowMinutes: 300, resetsAt: reset, resetDescription: nil)),
            NamedRateWindow(id: "antigravity-quota-summary-claude-session", title: "Claude/GPT 5-hour", window: RateWindow(usedPercent: 20, windowMinutes: 300, resetsAt: reset, resetDescription: nil)),
        ]
        let weeklyRows = [
            NamedRateWindow(id: "antigravity-quota-summary-gemini-weekly", title: "Gemini weekly", window: RateWindow(usedPercent: 30, windowMinutes: 10_080, resetsAt: reset, resetDescription: nil)),
            NamedRateWindow(id: "antigravity-quota-summary-claude-weekly", title: "Claude/GPT weekly", window: RateWindow(usedPercent: 40, windowMinutes: 10_080, resetsAt: reset, resetDescription: nil)),
        ]
        return UsageSnapshot(primary: sessionRows[0].window, secondary: sessionRows[1].window, extraRateWindows: includeWeekly ? sessionRows + weeklyRows : sessionRows, updatedAt: Date())
    }
}

private actor SnapshotSequence {
    private let snapshots: [UsageSnapshot]
    private var count = 0

    init(_ snapshots: [UsageSnapshot]) {
        self.snapshots = snapshots
    }

    func fetch() -> AntigravitySnapshotFetch {
        let index = min(count, snapshots.count - 1)
        count += 1
        return AntigravitySnapshotFetch(usage: snapshots[index])
    }

    func fetchCount() -> Int { count }
}
