import XCTest
import CodexBarCore
@testable import headroom_engine

final class AntigravityReadinessTests: XCTestCase {
    func testWaitsForQuotaSummaryThenEmitsBothWeeklyWindows() async throws {
        let sequence = SnapshotSequence([partialUsage(), completeUsage()])
        let fetched = try await AntigravitySnapshotWaiter.wait(
            timeout: 1,
            pollNanoseconds: 0,
            maximumAttempts: 2,
            fetch: { _ in await sequence.fetch() },
            sleep: { _ in })

        let fetchCount = await sequence.fetchCount()
        XCTAssertEqual(fetchCount, 2)
        XCTAssertTrue(AntigravitySnapshotWaiter.isReady(fetched.usage))
        let observations = HeadroomEngine.antigravityWindows(
            Principal(id: "antigravity-main", vendor: "antigravity", location: "agy"),
            usage: fetched.usage)
        XCTAssertEqual(observations.filter { $0.window?.minutes == 10_080 && $0.freshness == "fresh" }.count, 2)
        XCTAssertFalse(observations.contains { $0.freshness == "failed" })
    }

    func testIncompleteQuotaSummaryEmitsFailedWeeklyWindows() async throws {
        let sequence = SnapshotSequence([partialUsage(), partialUsage()])
        let fetched = try await AntigravitySnapshotWaiter.wait(
            timeout: 1,
            pollNanoseconds: 0,
            maximumAttempts: 2,
            fetch: { _ in await sequence.fetch() },
            sleep: { _ in })

        let fetchCount = await sequence.fetchCount()
        XCTAssertEqual(fetchCount, 2)
        XCTAssertFalse(AntigravitySnapshotWaiter.isReady(fetched.usage))
        let observations = HeadroomEngine.antigravityWindows(
            Principal(id: "antigravity-main", vendor: "antigravity", location: "agy"),
            usage: fetched.usage)
        let failedWeekly = observations.filter { $0.window?.minutes == 10_080 && $0.freshness == "failed" }
        XCTAssertEqual(Set(failedWeekly.map(\.meter_id)), ["antigravity-main:gemini", "antigravity-main:claude-gpt"])
        XCTAssertTrue(failedWeekly.allSatisfy { $0.reason == "quota summary not ready" })
    }

    /// Issue #55's second path: a `resetsAt == nil ? "rolling" : "fixed"`
    /// heuristic misclassifies an idle five-hour window (no reset reported
    /// this poll) as "fixed", flipping `Window.kind` poll-to-poll for the
    /// same 300-minute window and tripping the store's `vendor_window_held`
    /// guard on a classification bug rather than a real vendor change.
    /// Kind must instead come from the window's duration/identity, matching
    /// `src/adapters/antigravity.ts`'s static WINDOWS table: 5h is always
    /// "rolling" and weekly is always "fixed", with or without a reset.
    func testFiveHourWindowKindIsRollingRegardlessOfResetsAtPresence() {
        let reset = Date(timeIntervalSince1970: 1_800_000_000)
        let idleFiveHour = RateWindow(usedPercent: 0, windowMinutes: 300, resetsAt: nil, resetDescription: nil)
        let activeFiveHour = RateWindow(usedPercent: 10, windowMinutes: 300, resetsAt: reset, resetDescription: nil)
        XCTAssertEqual(AntigravitySnapshotWaiter.kind(for: idleFiveHour), "rolling")
        XCTAssertEqual(AntigravitySnapshotWaiter.kind(for: activeFiveHour), "rolling")

        let weeklyNoReset = RateWindow(usedPercent: 0, windowMinutes: 10_080, resetsAt: nil, resetDescription: nil)
        let weeklyWithReset = RateWindow(usedPercent: 30, windowMinutes: 10_080, resetsAt: reset, resetDescription: nil)
        XCTAssertEqual(AntigravitySnapshotWaiter.kind(for: weeklyNoReset), "fixed")
        XCTAssertEqual(AntigravitySnapshotWaiter.kind(for: weeklyWithReset), "fixed")
    }

    /// The same guarantee end-to-end through `antigravityWindows`, covering
    /// both the named quota-summary rows and the primary/secondary fallback
    /// path used before the quota summary has populated.
    func testAntigravityWindowsNeverFlipFiveHourKindWhenResetIsAbsent() {
        let idlePrimary = RateWindow(usedPercent: 0, windowMinutes: 300, resetsAt: nil, resetDescription: nil)
        let idleSecondary = RateWindow(usedPercent: 0, windowMinutes: 300, resetsAt: nil, resetDescription: nil)
        let usage = UsageSnapshot(primary: idlePrimary, secondary: idleSecondary, extraRateWindows: [], updatedAt: Date())
        let observations = HeadroomEngine.antigravityWindows(
            Principal(id: "antigravity-main", vendor: "antigravity", location: "agy"),
            usage: usage)
        let fiveHour = observations.filter { $0.window?.minutes == 300 }
        XCTAssertEqual(fiveHour.count, 2)
        XCTAssertTrue(fiveHour.allSatisfy { $0.window?.kind == "rolling" })
    }

    func testShapeListsOnlyAntigravityWindowDescriptors() {
        let shape = HeadroomEngine.antigravityShape(completeUsage())
        XCTAssertEqual(shape[0], "$: object")
        XCTAssertTrue(shape.contains { $0.contains("title=Gemini weekly") && $0.contains("id=antigravity-quota-summary-gemini-weekly") && $0.contains("minutes=10080") && $0.contains("resets_at=present") })
        XCTAssertFalse(shape.joined(separator: " ").contains("usedPercent"))
    }

    private func partialUsage() -> UsageSnapshot {
        usage(includeWeekly: false)
    }

    private func completeUsage() -> UsageSnapshot {
        usage(includeWeekly: true)
    }

    private func usage(includeWeekly: Bool) -> UsageSnapshot {
        let reset = Date(timeIntervalSince1970: 1_800_000_000)
        let sessionRows = [
            NamedRateWindow(id: "antigravity-quota-summary-gemini-session", title: "Gemini 5-hour", window: RateWindow(usedPercent: 10, windowMinutes: 300, resetsAt: reset, resetDescription: nil)),
            NamedRateWindow(id: "antigravity-quota-summary-claude-session", title: "Claude/GPT 5-hour", window: RateWindow(usedPercent: 20, windowMinutes: 300, resetsAt: reset, resetDescription: nil)),
        ]
        let weeklyRows = [
            NamedRateWindow(id: "antigravity-quota-summary-gemini-weekly", title: "Gemini weekly", window: RateWindow(usedPercent: 30, windowMinutes: 10_080, resetsAt: reset, resetDescription: nil)),
            NamedRateWindow(id: "antigravity-quota-summary-claude-weekly", title: "Claude/GPT weekly", window: RateWindow(usedPercent: 40, windowMinutes: 10_080, resetsAt: reset, resetDescription: nil)),
        ]
        return UsageSnapshot(primary: sessionRows[0].window, secondary: sessionRows[1].window, extraRateWindows: includeWeekly ? sessionRows + weeklyRows : sessionRows, updatedAt: Date())
    }
}

private actor SnapshotSequence {
    private let snapshots: [UsageSnapshot]
    private var count = 0

    init(_ snapshots: [UsageSnapshot]) {
        self.snapshots = snapshots
    }

    func fetch() -> AntigravitySnapshotFetch {
        let index = min(count, snapshots.count - 1)
        count += 1
        return AntigravitySnapshotFetch(usage: snapshots[index])
    }

    func fetchCount() -> Int { count }
}
