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
    func testGenericZeroWithoutResetEvidenceIsNeverOfficialFresh() {
        let rows = TallyEngine.windows(
            Principal(id: "other-main", vendor: "other", location: ""), meter: "main",
            windows: [RateWindow(usedPercent: 0, windowMinutes: 300, resetsAt: nil, resetDescription: nil)],
            source: "fixture")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].truth, "estimated")
        XCTAssertEqual(rows[0].freshness, "stale")
    }

    func testWaitsForQuotaSummaryThenEmitsBothWeeklyWindows() async throws {
        let sequence = SnapshotSequence([fixture("antigravity-partial"), fixture("antigravity-full")])
        let fetched = try await AntigravitySnapshotWaiter.wait(
            timeout: 1,
            pollNanoseconds: 0,
            maximumAttempts: 2,
            fetch: { _ in await sequence.fetch() },
            sleep: { _ in })

        let fetchCount = await sequence.fetchCount()
        XCTAssertEqual(fetchCount, 2)
        XCTAssertTrue(AntigravitySnapshotWaiter.isReady(fetched))
        let observations = TallyEngine.antigravityWindows(
            Principal(id: "antigravity-main", vendor: "antigravity", location: "agy"),
            snapshot: fetched)
        XCTAssertEqual(observations.filter { $0.window?.minutes == 10_080 && $0.freshness == "fresh" }.count, 2)
        XCTAssertFalse(observations.contains { $0.freshness == "failed" })
    }

    func testIncompleteQuotaSummaryEmitsFailedWeeklyWindows() async throws {
        let sequence = SnapshotSequence([fixture("antigravity-partial"), fixture("antigravity-partial")])
        let fetched = try await AntigravitySnapshotWaiter.wait(
            timeout: 1,
            pollNanoseconds: 0,
            maximumAttempts: 2,
            fetch: { _ in await sequence.fetch() },
            sleep: { _ in })

        let fetchCount = await sequence.fetchCount()
        XCTAssertEqual(fetchCount, 2)
        XCTAssertFalse(AntigravitySnapshotWaiter.isReady(fetched))
        let observations = TallyEngine.antigravityWindows(
            Principal(id: "antigravity-main", vendor: "antigravity", location: "agy"),
            snapshot: fetched)
        let failedWeekly = observations.filter { $0.window?.minutes == 10_080 && $0.freshness == "failed" }
        XCTAssertEqual(Set(failedWeekly.map(\.meter_id)), ["antigravity-main:gemini", "antigravity-main:claude-gpt"])
        XCTAssertTrue(failedWeekly.allSatisfy { $0.reason == "quota summary not ready" })
    }

    func testShapeListsOnlyAntigravityWindowDescriptors() {
        let shape = TallyEngine.antigravityShape(fixture("antigravity-full"))
        XCTAssertEqual(shape[0], "$: object")
        XCTAssertTrue(shape.contains("$.source: local-agy-existing"))
        XCTAssertTrue(shape.contains("$.payload_kind: RetrieveUserQuotaSummary"))
        XCTAssertTrue(shape.contains { $0.contains("title=Gemini weekly") && $0.contains("id=antigravity-quota-summary-gemini-weekly") && $0.contains("minutes=10080") && $0.contains("resets_at=present") })
        XCTAssertFalse(shape.joined(separator: " ").contains("usedPercent"))
    }

    func testAvailabilityOnlyFixtureIsRejectedAndEmitsAllExpectedFailedWindows() async throws {
        let snapshot = fixture("antigravity-availability-only")
        let sequence = SnapshotSequence([snapshot])
        let fetched = try await AntigravitySnapshotWaiter.wait(
            timeout: 1, pollNanoseconds: 0, maximumAttempts: 1,
            fetch: { _ in await sequence.fetch() }, sleep: { _ in })

        XCTAssertTrue(AntigravitySnapshotWaiter.isAvailabilityOnly(fetched))
        XCTAssertFalse(AntigravitySnapshotWaiter.isReady(fetched))
        let rows = TallyEngine.antigravityWindows(
            Principal(id: "antigravity-main", vendor: "antigravity", location: "agy"), snapshot: fetched)
        XCTAssertEqual(rows.count, 4)
        XCTAssertTrue(rows.allSatisfy { $0.freshness == "failed" && $0.truth == "estimated" })
        XCTAssertTrue(rows.allSatisfy { $0.reason?.contains("availability-only payload; quota summary not served (source: local-agy-existing)") == true })
        XCTAssertEqual(Set(rows.compactMap(\.window?.minutes)), [300, 10_080])
    }

    func testSyntheticAllZeroSummaryFixtureIsRejectedDefensively() {
        let fetchedAt = Date(timeIntervalSince1970: 1_800_000_000)
        let rows = [
            NamedRateWindow(id: "antigravity-quota-summary-gemini-session", title: "Gemini 5-hour", window: RateWindow(usedPercent: 0, windowMinutes: 300, resetsAt: fetchedAt.addingTimeInterval(300 * 60), resetDescription: "synthetic reset")),
            NamedRateWindow(id: "antigravity-quota-summary-claude-session", title: "Claude/GPT 5-hour", window: RateWindow(usedPercent: 0, windowMinutes: 300, resetsAt: fetchedAt.addingTimeInterval(300 * 60), resetDescription: "synthetic reset")),
            NamedRateWindow(id: "antigravity-quota-summary-gemini-weekly", title: "Gemini weekly", window: RateWindow(usedPercent: 0, windowMinutes: 10_080, resetsAt: fetchedAt.addingTimeInterval(10_080 * 60), resetDescription: "synthetic reset")),
            NamedRateWindow(id: "antigravity-quota-summary-claude-weekly", title: "Claude/GPT weekly", window: RateWindow(usedPercent: 0, windowMinutes: 10_080, resetsAt: fetchedAt.addingTimeInterval(10_080 * 60), resetDescription: "synthetic reset")),
        ]
        let usage = UsageSnapshot(primary: rows[0].window, secondary: rows[1].window, extraRateWindows: rows, updatedAt: fetchedAt)
        XCTAssertTrue(AntigravitySnapshotWaiter.isAvailabilityOnly(
            AntigravitySnapshotFetch(usage: usage, source: "local-agy-spawned", fetchedAt: fetchedAt)))
    }

    private func fixture(_ name: String) -> AntigravitySnapshotFetch {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/\(name).json")
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let decoded = try! decoder.decode(AntigravityFixture.self, from: Data(contentsOf: url))
        let formatter = ISO8601DateFormatter()
        let rows = decoded.windows.map { row in
            NamedRateWindow(id: row.id, title: row.title,
                window: RateWindow(usedPercent: row.usedPercent, windowMinutes: row.minutes,
                    resetsAt: row.resetsAt.flatMap(formatter.date(from:)), resetDescription: row.resetDescription))
        }
        return AntigravitySnapshotFetch(
            usage: UsageSnapshot(primary: rows.first?.window, secondary: rows.dropFirst().first?.window,
                extraRateWindows: rows, updatedAt: Date()),
            source: decoded.source, fetchedAt: formatter.date(from: decoded.fetchedAt)!)
    }
}

private struct AntigravityFixture: Decodable {
    let source: String
    let fetchedAt: String
    let windows: [Row]

    struct Row: Decodable {
        let id: String
        let title: String
        let usedPercent: Double
        let minutes: Int
        let resetsAt: String?
        let resetDescription: String?
    }
}

private actor SnapshotSequence {
    private let snapshots: [AntigravitySnapshotFetch]
    private var count = 0

    init(_ snapshots: [UsageSnapshot]) {
        self.snapshots = snapshots.map { AntigravitySnapshotFetch(usage: $0) }
    }

    init(_ snapshots: [AntigravitySnapshotFetch]) {
        self.snapshots = snapshots
    }

    func fetch() -> AntigravitySnapshotFetch {
        let index = min(count, snapshots.count - 1)
        count += 1
        return snapshots[index]
    }

    func fetchCount() -> Int { count }
}
