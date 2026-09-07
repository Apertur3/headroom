import XCTest
@testable import headroom_claude_probe

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Covers HeadroomClaudeProbe.token(_:) -- the exact guard that now
/// distinguishes HEADROOM_PROBE_LOGGED_OUT (item present, no usable OAuth
/// token) from HEADROOM_PROBE_NO_CREDENTIALS (item absent entirely, handled
/// upstream by the errSecItemNotFound branch and never reaching this
/// function). See issue #11.
final class LoggedOutCredentialTests: XCTestCase {
    func testReturnsTheAccessTokenWhenPresent() {
        let payload = Data(#"{"claudeAiOauth":{"accessToken":"synthetic-token","expiresAt":0}}"#.utf8)
        XCTAssertEqual(HeadroomClaudeProbe.token(payload), "synthetic-token")
    }

    func testReturnsNilWhenTheOauthObjectHasNoAccessToken() {
        let payload = Data(#"{"claudeAiOauth":{"expiresAt":0}}"#.utf8)
        XCTAssertNil(HeadroomClaudeProbe.token(payload))
    }

    func testReturnsNilWhenTheAccessTokenIsBlank() {
        let payload = Data(#"{"claudeAiOauth":{"accessToken":"   ","expiresAt":0}}"#.utf8)
        XCTAssertNil(HeadroomClaudeProbe.token(payload))
    }

    func testReturnsNilWhenTheClaudeAiOauthKeyIsMissingEntirely() {
        let payload = Data(#"{"somethingElse":true}"#.utf8)
        XCTAssertNil(HeadroomClaudeProbe.token(payload))
    }

    func testReturnsNilForUnparseableJSON() {
        XCTAssertNil(HeadroomClaudeProbe.token(Data("not json".utf8)))
    }
}
