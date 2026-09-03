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
}
