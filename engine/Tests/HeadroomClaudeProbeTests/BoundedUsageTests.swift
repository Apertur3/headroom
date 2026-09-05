import XCTest
@testable import headroom_claude_probe

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The probe's usage-JSON filter must reject a token-shaped value under any
/// key, not only a key literally named token/refresh/email: a vendor field
/// with an unrelated name can still carry a stray credential.
final class TokenShapeRedactionTests: XCTestCase {
    func testDetectsKnownTokenPrefixes() {
        XCTAssertTrue(containsTokenShapedSecret("sk-synthetic1234567890abcdef"))
        XCTAssertTrue(containsTokenShapedSecret("sk-ant-synthetic1234567890"))
        XCTAssertTrue(containsTokenShapedSecret("ya29.synthetic-access-token-value"))
        XCTAssertTrue(containsTokenShapedSecret("GOCSPX-synthetic1234567890"))
        XCTAssertTrue(containsTokenShapedSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"))
    }

    func testDetectsALongBase64OrHexRunEvenWithNoKnownPrefix() {
        XCTAssertTrue(containsTokenShapedSecret(String(repeating: "a1B2c3D4", count: 6)))
    }

    func testAcceptsOrdinaryShortValuesAndAvoidsSubstringFalsePositives() {
        XCTAssertFalse(containsTokenShapedSecret("pro"))
        XCTAssertFalse(containsTokenShapedSecret("2026-09-03T12:00:00Z"))
        // "risk-level" contains the substring "sk-" but is not token-shaped;
        // the check requires a word boundary before the prefix.
        XCTAssertFalse(containsTokenShapedSecret("risk-level"))
    }

    func testRejectsUsageJSONCarryingATokenShapedValueUnderAnUnrelatedKey() {
        let payload = Data(#"{"plan_type":"pro","note":"sk-synthetic1234567890abcdef"}"#.utf8)
        XCTAssertFalse(HeadroomClaudeProbe.safeUsageJSON(payload))
    }
}

/// RedirectRefusingDelegate also enforces the response byte cap while
/// streaming, via URLSessionDataDelegate.didReceive, cancelling the task the
/// moment accumulated bytes exceed the cap instead of buffering the whole
/// response first.
final class BoundedDataDelegateTests: XCTestCase {
    func testAccumulatesBytesBelowTheCapWithoutCancelling() {
        let delegate = RedirectRefusingDelegate(cap: 20)
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: URL(string: "https://api.anthropic.com/api/oauth/usage")!)
        defer { task.cancel() }
        delegate.urlSession(session, dataTask: task, didReceive: Data(repeating: 0x41, count: 10))
        XCTAssertFalse(delegate.capExceeded)
        XCTAssertEqual(delegate.data.count, 10)
    }

    func testCancelsTheTaskOnceAccumulatedBytesExceedTheCap() {
        let delegate = RedirectRefusingDelegate(cap: 10)
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: URL(string: "https://api.anthropic.com/api/oauth/usage")!)
        defer { task.cancel() }
        delegate.urlSession(session, dataTask: task, didReceive: Data(repeating: 0x41, count: 5))
        XCTAssertFalse(delegate.capExceeded)
        delegate.urlSession(session, dataTask: task, didReceive: Data(repeating: 0x42, count: 10))
        XCTAssertTrue(delegate.capExceeded)
        // Bytes received before the cap was crossed are still kept; nothing
        // received after capExceeded flips is appended.
        XCTAssertEqual(delegate.data.count, 15)
        delegate.urlSession(session, dataTask: task, didReceive: Data(repeating: 0x43, count: 5))
        XCTAssertEqual(delegate.data.count, 15)
    }
}
