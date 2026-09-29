import XCTest
@testable import CodexBarCore
@testable import headroom_engine

final class AntigravityRecordTests: XCTestCase {
    private let reset = Date(timeIntervalSince1970: 1_790_713_260) // fixed, synthetic

    /// Today's live shape: gemini weekly exhausted, gemini 5h bucket present
    /// but unusable (disabled, no fraction), claude/gpt lanes healthy.
    private func syntheticInput() -> AntigravityRecordInput {
        AntigravityRecordInput(
            isQuotaSummary: true,
            summaryDescription: "Quota for user@example.com",
            isLocal: true,
            buckets: [
                .init(group: "Gemini Models", bucketID: "gemini-5h", displayName: "5 hour", remainingFraction: nil, resetTime: nil, resetDescription: nil, disabled: true),
                .init(group: "Gemini Models", bucketID: "gemini-weekly", displayName: "Weekly", remainingFraction: 0, resetTime: reset, resetDescription: "Resets in 2d", disabled: false),
                .init(group: "Claude and GPT models", bucketID: "cg-5h", displayName: "5 hour", remainingFraction: 0.75, resetTime: reset, resetDescription: nil, disabled: false),
                .init(group: "Claude and GPT models", bucketID: "cg-weekly", displayName: "Weekly", remainingFraction: 0.5, resetTime: reset, resetDescription: nil, disabled: false),
            ],
            models: [])
    }

    func testRecordKeepsUnknownBucketsBeforeTheUsageKnownFilter() throws {
        let record = AntigravityRecorder.principalRecord(index: 0, input: syntheticInput())
        XCTAssertEqual(record.payload_kind, "quota_summary")
        XCTAssertEqual(record.buckets.count, 4)
        let fiveHour = try XCTUnwrap(record.buckets.first { $0.bucket_id == "gemini-5h" })
        XCTAssertTrue(fiveHour.disabled)
        XCTAssertNil(fiveHour.remaining_fraction)
        XCTAssertFalse(fiveHour.usage_known)
        let weekly = try XCTUnwrap(record.buckets.first { $0.bucket_id == "gemini-weekly" })
        XCTAssertEqual(weekly.remaining_fraction, 0)
        XCTAssertTrue(weekly.usage_known)
    }

    func testSerialisationIsStableRedactedAndExplicitAboutNulls() throws {
        let file = AntigravityRecordFile(
            schema: 1, recorded_at: "2026-09-30T00:00:00Z", engine_version: "0.1.0", probe_version: "v0.56.4",
            principals: [AntigravityRecorder.principalRecord(index: 0, input: syntheticInput())])
        let text = String(decoding: try AntigravityRecorder.encode(file), as: UTF8.self)
        XCTAssertFalse(text.contains("user@example.com"))
        XCTAssertTrue(text.contains("\"account\" : \"redacted\""))
        XCTAssertTrue(text.contains("\"principal\" : \"principal-0\""))
        XCTAssertTrue(text.contains("\"remaining_fraction\" : null"))
        XCTAssertTrue(text.contains("\"usage_known\" : false"))
        let decoded = try JSONDecoder().decode(AntigravityRecordFile.self, from: Data(text.utf8))
        XCTAssertEqual(decoded, file)
        // Deterministic key order so recorded fixtures diff cleanly.
        XCTAssertEqual(text, String(decoding: try AntigravityRecorder.encode(file), as: UTF8.self))
    }

    func testStatusExtractionCopiesOnlyAllowlistedFields() throws {
        // Public initialiser: model-quota fallback, with identity on the snapshot.
        let status = AntigravityStatusSnapshot(
            modelQuotas: [AntigravityModelQuota(label: "Model A", modelId: "model-a", remainingFraction: nil, resetTime: nil, resetDescription: nil)],
            accountEmail: "person@example.com",
            accountPlan: "Some Plan",
            source: .local)
        let record = AntigravityRecorder.principalRecord(index: 1, input: AntigravityRecorder.input(from: status))
        XCTAssertEqual(record.payload_kind, "availability_only")
        XCTAssertEqual(record.principal, "principal-1")
        let file = AntigravityRecordFile(schema: 1, recorded_at: "x", engine_version: "x", probe_version: "x", principals: [record])
        let text = String(decoding: try AntigravityRecorder.encode(file), as: UTF8.self)
        XCTAssertFalse(text.contains("person@example.com"))
        XCTAssertFalse(text.contains("Some Plan"))
    }

    /// Exercises the reflection path on the real (internal) quota-summary type.
    func testQuotaSummaryExtractionKeepsDisabledAndNilFraction() throws {
        let summary = AntigravityQuotaSummary(description: nil, groups: [
            AntigravityQuotaSummaryGroup(displayName: "Gemini Models", description: nil, buckets: [
                AntigravityQuotaSummaryBucket(bucketId: "g5", displayName: "5 hour", remainingFraction: nil, resetDescription: nil, disabled: true),
                AntigravityQuotaSummaryBucket(bucketId: "gw", displayName: "Weekly", remainingFraction: 0, resetTime: reset, resetDescription: nil, disabled: false),
            ]),
        ])
        let status = AntigravityStatusSnapshot(quotaSummary: summary, accountEmail: "person@example.com", accountPlan: "Some Plan")
        let record = AntigravityRecorder.principalRecord(index: 0, input: AntigravityRecorder.input(from: status))
        XCTAssertEqual(record.payload_kind, "quota_summary")
        XCTAssertEqual(record.buckets.map(\.bucket_id), ["g5", "gw"])
        XCTAssertEqual(record.buckets.map(\.usage_known), [false, true])
        XCTAssertEqual(record.buckets[0].disabled, true)
        XCTAssertNil(record.buckets[0].remaining_fraction)
        XCTAssertEqual(record.buckets[1].remaining_fraction, 0)
        XCTAssertNotNil(record.buckets[1].reset_time)
    }

    func testFileIsWrittenWithMode0600() throws {
        let path = NSTemporaryDirectory() + "headroom-record-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: path) }
        // Pre-existing wide file must be narrowed.
        FileManager.default.createFile(atPath: path, contents: Data(), attributes: [.posixPermissions: 0o644])
        try AntigravityRecorder.write(Data("{}\n".utf8), to: path)
        let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
    }

    /// Golden check: the record path must not change what `observe` and
    /// `observe --shape` derive from the same usage snapshot.
    func testObserveAndShapeOutputAreUnchangedForExhaustedWeekly() {
        let named = [
            NamedRateWindow(id: "antigravity-quota-summary-gemini-5h", title: "Gemini 5-hour", window: RateWindow(usedPercent: 0, windowMinutes: 300, resetsAt: nil, resetDescription: nil), usageKnown: false),
            NamedRateWindow(id: "antigravity-quota-summary-gemini-weekly", title: "Gemini weekly", window: RateWindow(usedPercent: 100, windowMinutes: 10_080, resetsAt: reset, resetDescription: nil)),
            NamedRateWindow(id: "antigravity-quota-summary-cg-5h", title: "Claude/GPT 5-hour", window: RateWindow(usedPercent: 25, windowMinutes: 300, resetsAt: reset, resetDescription: nil)),
            NamedRateWindow(id: "antigravity-quota-summary-cg-weekly", title: "Claude/GPT weekly", window: RateWindow(usedPercent: 50, windowMinutes: 10_080, resetsAt: reset, resetDescription: nil)),
        ]
        let usage = UsageSnapshot(primary: nil, secondary: nil, tertiary: nil, extraRateWindows: named, updatedAt: reset, identity: nil)
        XCTAssertEqual(HeadroomEngine.antigravityShape(usage), [
            "$: object",
            "$.windows: array[4]",
            "$.windows[0]: title=Gemini 5-hour, id=antigravity-quota-summary-gemini-5h, minutes=300, resets_at=absent",
            "$.windows[1]: title=Gemini weekly, id=antigravity-quota-summary-gemini-weekly, minutes=10080, resets_at=present",
            "$.windows[2]: title=Claude/GPT 5-hour, id=antigravity-quota-summary-cg-5h, minutes=300, resets_at=present",
            "$.windows[3]: title=Claude/GPT weekly, id=antigravity-quota-summary-cg-weekly, minutes=10080, resets_at=present",
        ])
        let observations = HeadroomEngine.antigravityWindows(Principal(id: "p", vendor: "antigravity", location: "agy"), usage: usage)
        // The unknown gemini 5h bucket is still dropped by observe (unchanged behaviour).
        XCTAssertEqual(observations.filter { $0.freshness == "fresh" }.map(\.meter_id).sorted(), ["p:claude-gpt", "p:claude-gpt", "p:gemini"])
        XCTAssertEqual(observations.filter { $0.freshness == "failed" }.count, 0)
    }
}
