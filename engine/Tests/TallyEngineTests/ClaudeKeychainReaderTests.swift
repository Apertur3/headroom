import XCTest
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
