import CodexBarCore
import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct Principal: Decodable {
    let id: String
    let vendor: String
    let location: String
}

struct Quantity: Codable {
    let used: Double
    let limit: Double
    let remaining: Double
    let unit: String
}

struct Window: Codable {
    let kind: String
    let minutes: Int?
    let enforcement: String
}

struct Observation: Codable {
    let principal_id: String
    let meter_id: String
    let window: Window?
    let quantity: Quantity?
    let resets_at: String?
    let observed_at: String
    let fetched_at: String
    let source: String
    let truth: String
    let freshness: String
    let confidence: Double
    let adapter_version: String
    let upstream_schema_version: String
    let reason: String?
    let metadata: ObservationMetadata?
    /// Antigravity only, additive: what agy sent for this lane, so the
    /// TypeScript lane classifier (src/antigravity-lanes.ts) can tell a
    /// disabled or usage-unknown bucket apart from a missing one. Omitted
    /// from the JSON when nil (every Codex row).
    var lane: LaneFacts? = nil
}

struct LaneFacts: Codable, Equatable {
    /// quota_summary | model_quota_fallback | availability_only
    let payload_kind: String
    /// "reported": the bucket was in agy's answer. "not_reported": the
    /// engine's placeholder for a weekly lane its readiness wait never saw.
    let bucket: String
    /// False: the bucket carries no usable usage, so the row has no quantity.
    let usage_known: Bool
    /// The vendor's own disabled flag, when the quota summary exposed it.
    let disabled: Bool?
}

/// Payload facts CodexBarCore's UsageSnapshot drops: which kind of answer
/// agy gave, and each quota-summary bucket's disabled flag by bucket id.
struct AntigravityPayloadFacts: Equatable {
    var payloadKind: String
    var disabledByBucketID: [String: Bool]

    /// Same vocabulary and rules as the recorder's `payload_kind`.
    init(status: AntigravityStatusSnapshot) {
        let input = AntigravityRecorder.input(from: status)
        if input.isQuotaSummary {
            payloadKind = "quota_summary"
        } else if !input.models.isEmpty, input.models.allSatisfy({ $0.remainingFraction == nil }) {
            payloadKind = "availability_only"
        } else {
            payloadKind = "model_quota_fallback"
        }
        disabledByBucketID = Dictionary(input.buckets.map { ($0.bucketID, $0.disabled) }, uniquingKeysWith: { first, second in first || second })
    }

    init(payloadKind: String, disabledByBucketID: [String: Bool] = [:]) {
        self.payloadKind = payloadKind
        self.disabledByBucketID = disabledByBucketID
    }

    /// Without the parsed status (tests that build a UsageSnapshot directly).
    static func derived(from usage: UsageSnapshot) -> AntigravityPayloadFacts {
        AntigravityPayloadFacts(payloadKind: AntigravitySnapshotWaiter.summaryWindows(in: usage).isEmpty ? "model_quota_fallback" : "quota_summary")
    }
}

private final class PayloadFactsBox: @unchecked Sendable {
    private let lock = NSLock()
    private var facts: AntigravityPayloadFacts?
    func set(_ value: AntigravityPayloadFacts) { lock.lock(); facts = value; lock.unlock() }
    func get() -> AntigravityPayloadFacts? { lock.lock(); defer { lock.unlock() }; return facts }
}

struct ObservationMetadata: Codable {
    let plan: String?
    let free_resets_available: Int?
}

struct ResponseShape: Codable {
    let principal_id: String
    let vendor: String
    let shape: [String]
    let error: String?
}

@main
struct HeadroomEngine {
    static let engineVersion = "0.1.0"
    static let upstreamVersion = "v0.56.4"

    static func main() async {
        let arguments = CommandLine.arguments
        let principalFlag = arguments.firstIndex(of: "--principals")
        let shapeMode = arguments.contains("--shape")
        if let recordFlag = arguments.firstIndex(of: "--record") {
            await runRecord(arguments: arguments, principalFlag: principalFlag, recordFlag: recordFlag, shapeMode: shapeMode)
        }
        guard (arguments.count == 4 || arguments.count == 5),
              arguments[1] == "observe",
              let principalFlag,
              principalFlag + 1 < arguments.count
        else {
            FileHandle.standardError.write(Data("Usage: headroom-engine observe --principals <path-to-json> [--shape]\n".utf8))
            exit(2)
        }

        let principals: [Principal]
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: arguments[principalFlag + 1]))
            principals = try JSONDecoder().decode([Principal].self, from: data)
        } catch {
            let observations = failed(principal: Principal(id: "invalid-input", vendor: "unknown", location: ""), meters: ["unknown"], error: error)
            emit(observations)
            exit(3)
        }
        if shapeMode {
            emit(await observeShapes(principals))
            exit(0)
        }
        let observations = await observe(principals)
        // The Core owns its spawned `agy` process. Always reset that session before this
        // one-shot engine exits; user/IDE-owned processes are never part of that session.
        await ProviderCLISessionLifecycle.shutdownPersistentSessions()
        emit(observations)
        exit(observations.contains { $0.freshness == "fresh" } ? 0 : 3)
    }

    /// `observe --principals <json> --record <out>`. Never returns.
    static func runRecord(arguments: [String], principalFlag: Int?, recordFlag: Int, shapeMode: Bool) async -> Never {
        guard arguments.count == 6, arguments[1] == "observe", !shapeMode,
              let principalFlag, principalFlag + 1 < arguments.count,
              recordFlag + 1 < arguments.count,
              !arguments[recordFlag + 1].hasPrefix("--"), !arguments[principalFlag + 1].hasPrefix("--")
        else {
            FileHandle.standardError.write(Data("Usage: headroom-engine observe --principals <path-to-json> --record <out-json>\n".utf8))
            exit(2)
        }
        let principals: [Principal]
        do {
            principals = try JSONDecoder().decode([Principal].self, from: try readRecordInput(arguments[principalFlag + 1]))
        } catch {
            FileHandle.standardError.write(Data("record: invalid principals input\n".utf8))
            exit(3)
        }
        exit(await AntigravityRecorder.run(principals: principals, outputPath: arguments[recordFlag + 1]))
    }

    /// The recorder's wrapper hands the principals over on stdin. Bash 5.1+ turns a short
    /// here-string into a pipe, and `Data(contentsOf:)` refuses anything but a regular
    /// file, so stdin is read through the file handle instead.
    static func readRecordInput(_ path: String, standardInput: FileHandle = .standardInput) throws -> Data {
        if path == "-" || path == "/dev/stdin" { return standardInput.readDataToEndOfFile() }
        return try Data(contentsOf: URL(fileURLWithPath: path))
    }

    static func emit<T: Encodable>(_ value: T) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let output = (try? encoder.encode(value)) ?? Data("[]".utf8)
        FileHandle.standardOutput.write(output)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    static func observe(_ principals: [Principal]) async -> [Observation] {
        var output: [Observation] = []
        for rawPrincipal in principals {
            let principal = safePrincipal(rawPrincipal)
            do {
                switch principal.vendor {
                case "codex": output += try await codex(principal)
                case "antigravity": output += try await antigravity(principal)
                default: throw EngineError.unsupportedVendor
                }
            } catch {
                output += failed(principal: principal, meters: meterNames(for: principal.vendor), error: error)
            }
        }
        return output
    }

    static func observeShapes(_ principals: [Principal]) async -> [ResponseShape] {
        var output: [ResponseShape] = []
        for rawPrincipal in principals {
            let principal = safePrincipal(rawPrincipal)
            do {
                switch principal.vendor {
                case "codex":
                    var environment = ProcessInfo.processInfo.environment
                    environment["CODEX_HOME"] = principal.location
                    let snapshot = try await UsageFetcher(environment: environment).loadLatestCLIAccountSnapshot()
                    output.append(ResponseShape(principal_id: principal.id, vendor: principal.vendor, shape: codexShape(snapshot), error: nil))
                case "antigravity":
                    let snapshot = try await antigravitySnapshot(principal)
                    output.append(ResponseShape(principal_id: principal.id, vendor: principal.vendor, shape: antigravityShape(snapshot.usage), error: nil))
                default: throw EngineError.unsupportedVendor
                }
            } catch {
                output.append(ResponseShape(principal_id: principal.id, vendor: principal.vendor, shape: [], error: redact(error.localizedDescription)))
            }
        }
        return output
    }

    /// CodexBarCore does not retain raw payloads. This remains structural and derives
    /// presence/nullness only from its parsed vendor response, so no values leak.
    static func codexShape(_ snapshot: CodexCLIAccountSnapshot) -> [String] {
        var shape = ["$: object", "$.usage: \(snapshot.usage == nil ? "null" : "object")"]
        if let usage = snapshot.usage {
            shape += ["$.usage.primary: \(usage.primary == nil ? "null" : "object")", "$.usage.secondary: \(usage.secondary == nil ? "null" : "object")", "$.usage.extraRateWindows: array[\(usage.extraRateWindows?.count ?? 0)]"]
        }
        return shape
    }

    /// Structural diagnostics for the normalized snapshot, deliberately omitting
    /// quota values and reset timestamps. The named quota-summary windows are
    /// the exact rows received by the engine, unlike the primary/secondary UI
    /// representatives which can collapse multiple cadences into one bar.
    static func antigravityShape(_ usage: UsageSnapshot) -> [String] {
        let named = AntigravitySnapshotWaiter.summaryWindows(in: usage)
        let windows: [(title: String, id: String, window: RateWindow)] = if named.isEmpty {
            [("Gemini", "none", usage.primary), ("Claude/GPT", "none", usage.secondary)]
                .compactMap { title, id, window in window.map { (title, id, $0) } }
        } else {
            named.map { ($0.title, $0.id, $0.window) }
        }
        return ["$: object", "$.windows: array[\(windows.count)]"]
            + windows.enumerated().map { index, row in
                let minutes = row.window.windowMinutes.map(String.init) ?? "null"
                let reset = row.window.resetsAt == nil ? "absent" : "present"
                return "$.windows[\(index)]: title=\(row.title), id=\(row.id), minutes=\(minutes), resets_at=\(reset)"
            }
    }

    static func shapeKind(_ value: Any) -> String {
        let mirror = Mirror(reflecting: value)
        switch mirror.displayStyle {
        case .collection: return "array[\(mirror.children.count)]"
        case .dictionary: return "object"
        case .optional: return mirror.children.isEmpty ? "null" : shapeKind(mirror.children.first!.value)
        case .struct, .class: return "object"
        default:
            if value is Bool { return "bool" }
            if value is String { return "string" }
            if value is any BinaryInteger || value is any BinaryFloatingPoint { return "number" }
            return "unknown"
        }
    }

    static func codex(_ principal: Principal) async throws -> [Observation] {
        var environment = ProcessInfo.processInfo.environment
        environment["CODEX_HOME"] = principal.location
        let snapshot = try await UsageFetcher(environment: environment).loadLatestCLIAccountSnapshot()
        let metadata = ObservationMetadata(plan: snapshot.usage?.identity?.loginMethod, free_resets_available: snapshot.usage?.codexResetCredits?.availableCount)
        var observations = windows(principal, meter: "main", windows: [snapshot.usage?.primary, snapshot.usage?.secondary], source: "engine:native:codex", metadata: metadata)
        // OpenAI currently returns a null primary/5-hour window for some accounts.
        // This is a vendor-confirmed absence of enforcement, distinct from a failed read.
        if snapshot.usage?.primary == nil {
            observations.append(notEnforcedWindow(principal, meter: "main", minutes: 300, source: "engine:native:codex", reason: "vendor returned no 5-hour window", metadata: metadata))
        }
        for extra in snapshot.usage?.extraRateWindows ?? [] where extra.title.localizedCaseInsensitiveContains("spark") {
            observations += windows(principal, meter: "spark", windows: [extra.window], source: "engine:native:codex", metadata: metadata)
        }
        if let credit = snapshot.credits?.codexCreditLimit {
            observations.append(observation(principal, meter: "credits", quantity: Quantity(used: credit.used, limit: credit.limit, remaining: credit.remaining, unit: "credits"), reset: credit.resetsAt, observed: credit.updatedAt, source: "engine:native:codex", window: nil, metadata: metadata))
        }
        guard !observations.isEmpty else { throw EngineError.noUsage }
        return observations
    }

    static func antigravity(_ principal: Principal) async throws -> [Observation] {
        let box = PayloadFactsBox()
        let snapshot = try await antigravitySnapshot(principal, observeStatus: { box.set(AntigravityPayloadFacts(status: $0)) })
        let observations = antigravityWindows(principal, usage: snapshot.usage, facts: box.get())
        guard !observations.isEmpty else { throw EngineError.noUsage }
        return observations
    }

    static func antigravitySnapshot(_ principal: Principal, observeStatus: @escaping @Sendable (AntigravityStatusSnapshot) -> Void = { _ in }) async throws -> AntigravitySnapshotFetch {
        do {
            // This is a user-owned local server (app, IDE, or `agy`). It is
            // already reachable, but its quota summary can still be warming.
            // 15s (10 attempts at this cadence) was too tight while agy was
            // busy: the weekly lane routinely missed that window and this
            // observed as a spurious source_failed a poll or two before agy
            // caught up on its own. 30s roughly doubles the retry budget
            // without materially lengthening a poll that is already bounded
            // by the TS caller's own 90s exec timeout.
            return try await AntigravitySnapshotWaiter.wait(
                timeout: 30,
                pollNanoseconds: 1_500_000_000,
                fetch: { remaining in
                    let status = try await AntigravityStatusProbe(timeout: min(8, remaining)).fetch()
                    let fetch = try AntigravitySnapshotFetch(status: status)
                    observeStatus(status)
                    return fetch
                })
        } catch AntigravityStatusProbeError.notRunning {
            // The TypeScript daemon owns the one long-lived agy PTY. A direct
            // engine invocation must not create a competing cold session: the
            // CLI one-shot uses the remote OAuth source instead.
            throw AntigravityStatusProbeError.notRunning
        }
    }

    static let quotaSummaryIDPrefix = "antigravity-quota-summary-"

    static func antigravityWindows(_ principal: Principal, usage: UsageSnapshot, facts: AntigravityPayloadFacts? = nil) -> [Observation] {
        let source = "local:antigravity:warm"
        let summaryWindows = AntigravitySnapshotWaiter.summaryWindows(in: usage)
        let facts = facts ?? .derived(from: usage)
        // The summary windows come from CodexBarCore's public snapshot; the
        // reflected facts only refine the no-summary case, so upstream drift
        // in the reflection can never demote a real quota summary.
        let kind = !summaryWindows.isEmpty ? "quota_summary" : facts.payloadKind == "availability_only" ? "availability_only" : "model_quota_fallback"
        var output: [Observation] = []

        if summaryWindows.isEmpty {
            // No quota summary: per-model representatives only. Without any
            // fraction (availability only) their percent is not usage.
            let lane = LaneFacts(payload_kind: kind, bucket: "reported", usage_known: kind != "availability_only", disabled: nil)
            output += windows(principal, meter: "gemini", windows: [usage.primary], source: source, kind: AntigravitySnapshotWaiter.kind(for:), lane: lane)
            output += windows(principal, meter: "claude-gpt", windows: [usage.secondary], source: source, kind: AntigravitySnapshotWaiter.kind(for:), lane: lane)
        } else {
            for named in summaryWindows {
                guard let meter = AntigravitySnapshotWaiter.meter(for: named) else { continue }
                let bucketID = named.id.hasPrefix(quotaSummaryIDPrefix) ? String(named.id.dropFirst(quotaSummaryIDPrefix.count)) : named.id
                let disabled = facts.disabledByBucketID[bucketID]
                if named.usageKnown {
                    output += windows(principal, meter: meter, windows: [named.window], source: source, kind: AntigravitySnapshotWaiter.kind(for:),
                                      lane: LaneFacts(payload_kind: kind, bucket: "reported", usage_known: true, disabled: disabled))
                } else {
                    // Disabled or fraction-less: emitted with its state rather
                    // than dropped, and without the placeholder percent
                    // CodexBarCore fills in, so it can never read as capacity.
                    output.append(unknownUsageWindow(principal, meter: meter, window: named.window, source: source,
                                                     lane: LaneFacts(payload_kind: kind, bucket: "reported", usage_known: false, disabled: disabled)))
                }
            }
        }

        // A partial status payload must not allow an old weekly observation to
        // masquerade as current. Emit the missing per-group weekly lane as a
        // failed observation so Headroom's fail-closed status becomes UNKNOWN.
        let presentWeeklyMeters = Set(summaryWindows
            .filter { $0.window.windowMinutes == AntigravitySnapshotWaiter.weeklyMinutes }
            .compactMap(AntigravitySnapshotWaiter.meter(for:)))
        for meter in AntigravitySnapshotWaiter.expectedMeters.sorted() where !presentWeeklyMeters.contains(meter) {
            output.append(failedWeeklyWindow(principal, meter: meter, source: source,
                                             lane: LaneFacts(payload_kind: kind, bucket: "not_reported", usage_known: false, disabled: nil)))
        }
        return output
    }

    /// A reported bucket without usable usage: failed, no quantity, no reset.
    static func unknownUsageWindow(_ principal: Principal, meter: String, window: RateWindow, source: String, lane: LaneFacts) -> Observation {
        let now = iso(Date())!
        let why = lane.disabled == true ? "bucket disabled" : "no remaining fraction"
        return Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: Window(kind: AntigravitySnapshotWaiter.kind(for: window), minutes: window.windowMinutes, enforcement: "hard"), quantity: nil, resets_at: nil, observed_at: now, fetched_at: now, source: source, truth: "estimated", freshness: "failed", confidence: 0, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: "vendor sent this bucket without usage (\(why))", metadata: nil, lane: lane)
    }

    /// `kind` classifies a seen window's `Window.kind`. Defaults to the
    /// legacy resetsAt-presence heuristic (still correct for Codex, which
    /// has no fixed window-identity table). Antigravity callers pass
    /// `AntigravitySnapshotWaiter.kind(for:)` instead, which classifies by
    /// window duration/identity -- see that function's doc comment.
    static func windows(_ principal: Principal, meter: String, windows: [RateWindow?], source: String, metadata: ObservationMetadata? = nil, kind: (RateWindow) -> String = { $0.resetsAt == nil ? "rolling" : "fixed" }, lane: LaneFacts? = nil) -> [Observation] {
        windows.compactMap { value in
            guard let value, !value.isSyntheticPlaceholder else { return nil }
            return observation(principal, meter: meter, quantity: Quantity(used: value.usedPercent, limit: 100, remaining: value.remainingPercent, unit: "percent"), reset: value.resetsAt, observed: Date(), source: source, window: Window(kind: kind(value), minutes: value.windowMinutes, enforcement: "hard"), metadata: metadata, lane: lane)
        }
    }

    static func observation(_ principal: Principal, meter: String, quantity: Quantity, reset: Date?, observed: Date, source: String, window: Window?, metadata: ObservationMetadata? = nil, lane: LaneFacts? = nil) -> Observation {
        Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: window, quantity: quantity, resets_at: iso(reset), observed_at: iso(observed)!, fetched_at: iso(Date())!, source: source, truth: "official", freshness: "fresh", confidence: 1, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: nil, metadata: metadata, lane: lane)
    }

    static func notEnforcedWindow(_ principal: Principal, meter: String, minutes: Int, source: String, reason: String, metadata: ObservationMetadata? = nil) -> Observation {
        let now = iso(Date())!
        return Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: Window(kind: "rolling", minutes: minutes, enforcement: "hard"), quantity: nil, resets_at: nil, observed_at: now, fetched_at: now, source: source, truth: "official", freshness: "not_enforced", confidence: 1, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: reason, metadata: metadata)
    }

    static func failedWeeklyWindow(_ principal: Principal, meter: String, source: String, lane: LaneFacts? = nil) -> Observation {
        let now = iso(Date())!
        return Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: Window(kind: "fixed", minutes: AntigravitySnapshotWaiter.weeklyMinutes, enforcement: "hard"), quantity: nil, resets_at: nil, observed_at: now, fetched_at: now, source: source, truth: "estimated", freshness: "failed", confidence: 0, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: "quota summary not ready", metadata: nil, lane: lane)
    }

    static func failed(principal: Principal, meters: [String], error: Error) -> [Observation] {
        let now = iso(Date())!
        return meters.map { meter in Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: nil, quantity: nil, resets_at: nil, observed_at: now, fetched_at: now, source: "engine:native", truth: "estimated", freshness: "failed", confidence: 0, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: redact(error.localizedDescription), metadata: nil) }
    }

    static func meterNames(for vendor: String) -> [String] {
        switch vendor { case "codex": ["main", "spark", "credits"]; case "antigravity": ["gemini", "claude-gpt"]; default: ["unknown"] }
    }

    static func safePrincipal(_ principal: Principal) -> Principal {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        let safeID = principal.id.unicodeScalars.allSatisfy(allowed.contains) && !principal.id.isEmpty
            ? principal.id : "invalid-principal"
        return Principal(id: safeID, vendor: principal.vendor, location: principal.location)
    }

    static func iso(_ date: Date?) -> String? {
        guard let date else { return nil }
        return ISO8601DateFormatter().string(from: date)
    }

    static func redact(_ input: String) -> String {
        var value = input.replacingOccurrences(of: #"(?i)bearer\s+[^\s,;]+|eyJ[A-Za-z0-9._-]+|sk-[A-Za-z0-9._-]+"#, with: "[REDACTED]", options: .regularExpression)
        value = value.replacingOccurrences(of: #"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#, with: "[REDACTED]", options: .regularExpression)
        return String(value.prefix(180))
    }
}

enum EngineError: LocalizedError { case unsupportedVendor, noUsage
    var errorDescription: String? { switch self { case .unsupportedVendor: "unsupported vendor"; case .noUsage: "provider returned no quota windows" } }
}
