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
                AntigravityQuotaSummaryBucket(bucketId: "gemini-5h", displayName: "5 hour", remainingFraction: nil, resetDescription: nil, disabled: true),
                AntigravityQuotaSummaryBucket(bucketId: "gemini-weekly", displayName: "Weekly", remainingFraction: 0, resetTime: reset, resetDescription: nil, disabled: false),
            ]),
        ])
        let status = AntigravityStatusSnapshot(quotaSummary: summary, accountEmail: "person@example.com", accountPlan: "Some Plan")
        let record = AntigravityRecorder.principalRecord(index: 0, input: AntigravityRecorder.input(from: status))
        XCTAssertEqual(record.payload_kind, "quota_summary")
        XCTAssertEqual(record.buckets.map(\.bucket_id), ["gemini-5h", "gemini-weekly"])
        XCTAssertEqual(record.buckets.map(\.usage_known), [false, true])
        XCTAssertEqual(record.buckets[0].disabled, true)
        XCTAssertNil(record.buckets[0].remaining_fraction)
        XCTAssertEqual(record.buckets[1].remaining_fraction, 0)
        XCTAssertNotNil(record.buckets[1].reset_time)
    }

    func testFileIsCreatedWithMode0600() throws {
        let path = NSTemporaryDirectory() + "headroom-record-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: path) }
        try AntigravityRecorder.write(Data("{}\n".utf8), to: path)
        let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
    }

    func testExistingFileIsNeverOverwritten() throws {
        let path = NSTemporaryDirectory() + "headroom-record-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: path) }
        try Data("keep me".utf8).write(to: URL(fileURLWithPath: path))
        XCTAssertThrowsError(try AntigravityRecorder.write(Data("{}\n".utf8), to: path)) { error in
            XCTAssertEqual(error as? AntigravityRecorder.RecordError, .exists)
        }
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "keep me")
    }

    private let hostile = [
        "csrf_token=abc123def456", "Cookie: session=abcdef", "someone@example.com",
        "123e4567-e89b-12d3-a456-426614174000", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
        "Name Surname wrote this", "0123456789abcdef0123456789abcdef", "QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVu",
    ]

    private let semanticHostile = ["Alice Smith", "project-42", "--profile work", "x9Kd82LmQ4zA"]

    func testHostileStringsNeverReachTheFile() throws {
        var buckets: [AntigravityRecordInput.Bucket] = []
        var models: [AntigravityRecordInput.Model] = []
        for h in hostile + semanticHostile {
            let label = h
            buckets.append(.init(group: label, bucketID: label, displayName: label, remainingFraction: 0.5, resetTime: reset, resetDescription: h, disabled: false))
            models.append(.init(label: label, modelID: label, remainingFraction: 0.5, resetTime: reset, resetDescription: h))
        }
        let input = AntigravityRecordInput(isQuotaSummary: true, isLocal: true, buckets: buckets, models: models)
        let failed = hostile.map { AntigravityRecorder.failedRecord(index: 1, vendor: "antigravity", code: AntigravityRecordError.code(for: AntigravityStatusProbeError.apiError($0))) }
        let file = AntigravityRecordFile(schema: 1, recorded_at: "x", engine_version: "x", probe_version: "x",
                                         principals: [AntigravityRecorder.principalRecord(index: 0, input: input)] + failed)
        let text = String(decoding: try AntigravityRecorder.encode(file), as: UTF8.self)
        for h in hostile + semanticHostile {
            XCTAssertFalse(text.contains(h), h)
        }
        for fragment in ["Alice", "Smith", "project-42", "--profile", "x9Kd82"] {
            XCTAssertFalse(text.contains(fragment), fragment)
        }
        XCTAssertTrue(text.contains("bucket-1") && text.contains("group-1") && text.contains("model-1"))
        for fragment in ["csrf", "session=", "example.com", "123e4567", "eyJ", "Surname", "0123456789abcdef", "QWxhZGRpbjpv"] {
            XCTAssertFalse(text.contains(fragment), fragment)
        }
        XCTAssertTrue(text.contains("redacted"))
        XCTAssertTrue(text.contains("\"error\" : \"api_error\""))
    }

    func testKnownIdsSurviveAndEverythingElseIsPositional() {
        for id in ["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"] {
            XCTAssertEqual(AntigravityRecorder.bucketName(id, placeholder: "bucket-9"), id)
        }
        XCTAssertEqual(AntigravityRecorder.bucketName("Claude and GPT models", placeholder: "group-2"), "group-2")
        XCTAssertEqual(AntigravityRecorder.bucketName("Weekly", placeholder: "bucket-3"), "bucket-3")
        XCTAssertEqual(AntigravityRecorder.modelName("gemini-3.7-flash", placeholder: "model-1"), "gemini-3.7-flash")
        XCTAssertEqual(AntigravityRecorder.modelName("claude-sonnet-4", placeholder: "model-1"), "claude-sonnet-4")
        XCTAssertEqual(AntigravityRecorder.modelName("Gemini 3 Pro (High)", placeholder: "model-2"), "model-2")
        XCTAssertEqual(AntigravityRecorder.modelName("project-42", placeholder: "model-3"), "model-3")
        for unknown in ["gemini-project-42", "claude-alice-smith", "gpt-x9kd82lmq4za"] {
            XCTAssertEqual(AntigravityRecorder.modelName(unknown, placeholder: "model-4"), "model-4")
        }
        XCTAssertEqual(AntigravityRecorder.structuredReset("Resets in 2d 3h"), "Resets in 2d 3h")
        XCTAssertNil(AntigravityRecorder.structuredReset("Resets in 2d for user@example.com"))
    }

    func testErrorsMapToFixedCodes() {
        XCTAssertEqual(AntigravityRecordError.code(for: AntigravityStatusProbeError.timedOut), .timedOut)
        XCTAssertEqual(AntigravityRecordError.code(for: AntigravityStatusProbeError.accountMismatch(expected: "user@example.com", found: "other@example.com")), .accountMismatch)
        XCTAssertEqual(AntigravityRecordError.code(for: NSError(domain: "csrf_token=zzz", code: 1)), .other)
    }

    // Schema drift: mirror types that look like the upstream ones but renamed a field.
    private struct DriftBucket { var bucketId = "b"; var displayName = "n"; var remainingFraction: Double? = 0.5; var resetTime: Date? = nil; var resetDescription: String? = nil; var isDisabled = false }
    private struct DriftGroup { var displayName = "g"; var buckets = [DriftBucket()] }
    private struct DriftSummary { var description: String? = nil; var groupList = [DriftGroup()] }
    private struct DriftHost { var quotaSummary: DriftSummary? = DriftSummary() }
    private struct DriftGroup2 { var displayName = "g"; var buckets = [DriftBucket()] }
    private struct DriftSummary2 { var description: String? = nil; var groups = [DriftGroup2()] }
    private struct DriftHost2 { var quotaSummary: DriftSummary2? = DriftSummary2() }
    private struct DriftHost3 { var quota: Int = 0 }

    func testSchemaDriftIsReportedNotDefaulted() {
        let renamedGroups = AntigravityRecorder.extractSummary(from: DriftHost())
        XCTAssertEqual(renamedGroups.extractionErrors, ["missing field: groups"])
        XCTAssertTrue(renamedGroups.buckets.isEmpty)

        let renamedDisabled = AntigravityRecorder.extractSummary(from: DriftHost2())
        XCTAssertTrue(renamedDisabled.extractionErrors.contains("missing field: disabled"))
        XCTAssertEqual(renamedDisabled.buckets.first?.disabled, true, "missing disabled must never default to enabled")

        let renamedSummary = AntigravityRecorder.extractSummary(from: DriftHost3())
        XCTAssertEqual(renamedSummary.extractionErrors, ["missing field: quotaSummary"])

        let record = AntigravityRecorder.principalRecord(index: 0, input: renamedGroups)
        XCTAssertEqual(record.extraction_errors, ["missing field: groups"])
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

    /// Bash 5.1+ delivers a short here-string as a pipe; the record input must accept it.
    func testRecordInputReadsPrincipalsFromAPipe() throws {
        let pipe = Pipe()
        let json = Data(#"[{"id":"antigravity","vendor":"antigravity","location":"agy"}]"#.utf8)
        pipe.fileHandleForWriting.write(json)
        try pipe.fileHandleForWriting.close()
        XCTAssertEqual(try HeadroomEngine.readRecordInput("/dev/stdin", standardInput: pipe.fileHandleForReading), json)
    }
}
