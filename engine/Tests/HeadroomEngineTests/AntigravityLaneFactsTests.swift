import XCTest
@testable import CodexBarCore
@testable import headroom_engine

/// Feeds the recorded live payload (test/fixtures/antigravity/, captured with
/// `observe --record`) through CodexBarCore's real quota-summary conversion
/// and the engine's `antigravityWindows`, so the TypeScript lane classifier's
/// fixture tests and the engine agree on what agy sent.
final class AntigravityLaneFactsTests: XCTestCase {
    private func fixture(_ name: String) throws -> AntigravityRecordFile {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/antigravity/\(name)")
        return try JSONDecoder().decode(AntigravityRecordFile.self, from: Data(contentsOf: url))
    }

    /// The recording redacts group names; only the bucket ids survive. The
    /// group each id belongs to is the one agy always uses for it.
    private func groupName(for bucketID: String) -> String {
        bucketID.hasPrefix("gemini") ? "Gemini Models" : "Claude and GPT models"
    }

    private func makeStatus(from record: AntigravityRecordPrincipal) -> AntigravityStatusSnapshot {
        let formatter = ISO8601DateFormatter()
        var order: [String] = []
        var grouped: [String: [AntigravityQuotaSummaryBucket]] = [:]
        for bucket in record.buckets {
            let group = groupName(for: bucket.bucket_id)
            if grouped[group] == nil { order.append(group) }
            grouped[group, default: []].append(AntigravityQuotaSummaryBucket(
                bucketId: bucket.bucket_id, displayName: bucket.name, remainingFraction: bucket.remaining_fraction,
                resetTime: bucket.reset_time.flatMap(formatter.date(from:)), resetDescription: bucket.reset_description, disabled: bucket.disabled))
        }
        let summary = AntigravityQuotaSummary(description: nil, groups: order.map {
            AntigravityQuotaSummaryGroup(displayName: $0, description: nil, buckets: grouped[$0] ?? [])
        })
        return AntigravityStatusSnapshot(quotaSummary: summary, accountEmail: nil, accountPlan: nil)
    }

    func testRecordedWeeklyExhaustedPayloadEmitsTheDisabledFiveHourBucketWithItsState() throws {
        let record = try XCTUnwrap(try fixture("2026-09-29-weekly-exhausted.json").principals.first)
        let status = makeStatus(from: record)
        let facts = AntigravityPayloadFacts(status: status)
        XCTAssertEqual(facts.payloadKind, "quota_summary")
        XCTAssertEqual(facts.disabledByBucketID["gemini-5h"], true)

        let usage = try status.toUsageSnapshot()
        let rows = HeadroomEngine.antigravityWindows(Principal(id: "agy", vendor: "antigravity", location: "agy"), usage: usage, facts: facts)
        XCTAssertEqual(rows.count, 4, "every bucket agy sent is emitted; none dropped, no placeholder added")

        let gemini5h = try XCTUnwrap(rows.first { $0.meter_id == "agy:gemini" && $0.window?.minutes == 300 })
        XCTAssertEqual(gemini5h.freshness, "failed")
        XCTAssertNil(gemini5h.quantity, "the vendor's fraction of 1 on a disabled bucket is not usage")
        XCTAssertEqual(gemini5h.lane, LaneFacts(payload_kind: "quota_summary", bucket: "reported", usage_known: false, disabled: true))

        let geminiWeekly = try XCTUnwrap(rows.first { $0.meter_id == "agy:gemini" && $0.window?.minutes == 10_080 })
        XCTAssertEqual(geminiWeekly.freshness, "fresh")
        XCTAssertEqual(geminiWeekly.quantity?.used, 100)
        XCTAssertEqual(geminiWeekly.resets_at, "2026-09-30T20:21:49Z")

        let others = rows.filter { $0.meter_id == "agy:claude-gpt" }
        XCTAssertEqual(others.count, 2)
        XCTAssertTrue(others.allSatisfy { $0.freshness == "fresh" && $0.lane?.usage_known == true })

        // Additive JSON: the lane facts ride along; Codex-style rows without
        // them encode exactly as before.
        let json = String(decoding: try JSONEncoder().encode(gemini5h), as: UTF8.self)
        XCTAssertTrue(json.contains("\"lane\":{"))
        let plain = HeadroomEngine.notEnforcedWindow(Principal(id: "cx", vendor: "codex", location: "x"), meter: "main", minutes: 300, source: "s", reason: "r")
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(plain), as: UTF8.self).contains("\"lane\""))
    }
}
