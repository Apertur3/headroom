import XCTest
@testable import headroom_claude_probe

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// `URLSession.shared` follows redirects and resends the Authorization header
/// to whatever host issued the 3xx. RedirectRefusingDelegate is what stands
/// between a hijacked or misconfigured usage endpoint and a leaked bearer
/// token, so its refusal is asserted directly against a stub redirect.
final class RedirectRefusalTests: XCTestCase {
    func testCancelsEveryRedirect() {
        let delegate = RedirectRefusingDelegate()
        let session = URLSession(configuration: .ephemeral)
        let originalURL = URL(string: "https://api.anthropic.com/api/oauth/usage")!
        let task = session.dataTask(with: URLRequest(url: originalURL))
        defer { task.cancel() }

        // A stub 302 pointing away from the trusted host, exactly what a
        // hijacked or misconfigured usage endpoint would send.
        let stubRedirectResponse = HTTPURLResponse(url: originalURL, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": "https://attacker.example/steal"])!
        let stubRedirectedRequest = URLRequest(url: URL(string: "https://attacker.example/steal")!)

        let decided = expectation(description: "redirect decision delivered")
        delegate.urlSession(session, task: task, willPerformHTTPRedirection: stubRedirectResponse, newRequest: stubRedirectedRequest) { decision in
            XCTAssertNil(decision, "a non-nil request here would follow the redirect and resend Authorization to attacker.example")
            decided.fulfill()
        }
        wait(for: [decided], timeout: 1)
    }
}

final class AnthropicHostCheckTests: XCTestCase {
    func testAcceptsOnlyTheExactAnthropicHost() {
        XCTAssertTrue(isAnthropicUsageHost(URL(string: "https://api.anthropic.com/api/oauth/usage")))
        XCTAssertFalse(isAnthropicUsageHost(URL(string: "https://attacker.example/api/oauth/usage")))
        // A redirect to a lookalike host must not pass either.
        XCTAssertFalse(isAnthropicUsageHost(URL(string: "https://api.anthropic.com.attacker.example/x")))
        XCTAssertFalse(isAnthropicUsageHost(nil))
    }
}

final class EmailRedactionTests: XCTestCase {
    func testDetectsAnEmailAddressRegardlessOfSurroundingText() {
        XCTAssertTrue(containsEmailAddress("owner@example.com"))
        XCTAssertTrue(containsEmailAddress("contact owner@example.com for help"))
        XCTAssertFalse(containsEmailAddress("no address in this string"))
    }

    func testRejectsUsageJSONCarryingAnEmailUnderAnUnrelatedKey() {
        // The vendor field name isn't "email", but the value is one; the
        // filter must look at values, not only key names.
        let payload = Data(#"{"plan_type":"pro","note":"owner@example.com"}"#.utf8)
        XCTAssertFalse(HeadroomClaudeProbe.safeUsageJSON(payload))
    }

    func testAcceptsUsageJSONWithNoEmailOrCredentialKeys() {
        let payload = Data(#"{"plan_type":"pro","five_hour":{"utilization":10}}"#.utf8)
        XCTAssertTrue(HeadroomClaudeProbe.safeUsageJSON(payload))
    }
}
