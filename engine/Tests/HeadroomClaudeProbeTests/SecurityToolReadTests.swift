import Foundation
import XCTest
@testable import headroom_claude_probe

/// Covers the parsing and classification of a `/usr/bin/security
/// find-generic-password -w` run: the read path the probe actually answers
/// through, since Claude Code's own rewrite of its Keychain item leaves an
/// access list that admits Apple-signed tools and not this binary.
///
/// Nothing here touches a Keychain, spawns `security`, or handles a real
/// credential: every input is a synthetic byte string.
final class SecurityToolReadTests: XCTestCase {
    private let payload = Data(#"{"claudeAiOauth":{"accessToken":"synthetic-token"}}"#.utf8)

    func testStripsTheSingleTrailingNewlineSecurityWrites() {
        var output = payload
        output.append(0x0A)
        XCTAssertEqual(HeadroomClaudeProbe.passwordFromSecurityOutput(output), payload)
    }

    func testStripsACarriageReturnLineFeedPairToo() {
        var output = payload
        output.append(contentsOf: [0x0D, 0x0A])
        XCTAssertEqual(HeadroomClaudeProbe.passwordFromSecurityOutput(output), payload)
    }

    func testKeepsOutputThatHasNoTrailingLineEndingAtAll() {
        XCTAssertEqual(HeadroomClaudeProbe.passwordFromSecurityOutput(payload), payload)
    }

    func testReturnsNilForEmptyOutput() {
        XCTAssertNil(HeadroomClaudeProbe.passwordFromSecurityOutput(Data()))
    }

    func testReturnsNilForOutputThatIsNothingButLineEndings() {
        XCTAssertNil(HeadroomClaudeProbe.passwordFromSecurityOutput(Data([0x0D, 0x0A, 0x0A])))
    }

    func testExitZeroWithAPasswordIsACredential() {
        var output = payload
        output.append(0x0A)
        XCTAssertEqual(HeadroomClaudeProbe.outcome(status: 0, output: output), .credential(payload))
    }

    func testExitFortyFourIsAnAbsentItem() {
        // `security`'s own status for "The specified item could not be found
        // in the keychain": a genuinely absent login, not a failed tool.
        XCTAssertEqual(HeadroomClaudeProbe.outcome(status: 44, output: Data()), .absent)
    }

    func testExitZeroWithNothingUsableIsAlsoAnAbsentItem() {
        XCTAssertEqual(HeadroomClaudeProbe.outcome(status: 0, output: Data([0x0A])), .absent)
    }

    func testAnyOtherNonZeroExitCarriesTheToolsStatus() {
        XCTAssertEqual(HeadroomClaudeProbe.outcome(status: 51, output: Data()), .failed(51))
        XCTAssertEqual(HeadroomClaudeProbe.outcome(status: 1, output: Data()), .failed(1))
    }

    func testDrainCollectsEverythingWrittenBeforeTheWriterCloses() {
        let pipe = Pipe()
        let output = SecurityToolOutput(pipe.fileHandleForReading)
        pipe.fileHandleForWriting.write(Data("first".utf8))
        pipe.fileHandleForWriting.write(Data("second".utf8))
        try? pipe.fileHandleForWriting.close()
        output.drain(cap: 1_048_576)
        XCTAssertEqual(output.data, Data("firstsecond".utf8))
        XCTAssertFalse(output.overCap)
    }

    func testDrainStopsAndFlagsOutputLargerThanTheCap() {
        let pipe = Pipe()
        let output = SecurityToolOutput(pipe.fileHandleForReading)
        pipe.fileHandleForWriting.write(Data(repeating: 0x41, count: 64))
        try? pipe.fileHandleForWriting.close()
        output.drain(cap: 8)
        XCTAssertTrue(output.overCap)
    }
}
