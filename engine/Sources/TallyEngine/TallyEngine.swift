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
}

struct ObservationMetadata: Codable {
    let plan: String?
    let free_resets_available: Int?
}

struct ResponseShape: Codable {
    let principal_id: String
    let vendor: String
    let source: String?
    let shape: [String]
    let error: String?
}

@main
struct TallyEngine {
    static let engineVersion = "0.1.0"
    static let upstreamVersion = "v0.56.4"

    static func main() async {
        let arguments = CommandLine.arguments
        let principalFlag = arguments.firstIndex(of: "--principals")
        let shapeMode = arguments.contains("--shape")
        guard (arguments.count == 4 || arguments.count == 5),
              arguments[1] == "observe",
              let principalFlag,
              principalFlag + 1 < arguments.count
        else {
            FileHandle.standardError.write(Data("Usage: tally-engine observe --principals <path-to-json> [--shape]\n".utf8))
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
                case "claude": output += try await claude(principal)
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
                case "claude":
                    let credentials = try await ClaudeKeychainReader.load(configDirectory: principal.location)
                    guard !credentials.isExpired else { throw EngineError.expiredCredential }
                    output.append(ResponseShape(principal_id: principal.id, vendor: principal.vendor, source: "engine:native:claude", shape: try await ClaudeOAuthUsageReader.shape(accessToken: credentials.accessToken), error: nil))
                case "codex":
                    var environment = ProcessInfo.processInfo.environment
                    environment["CODEX_HOME"] = principal.location
                    let snapshot = try await UsageFetcher(environment: environment).loadLatestCLIAccountSnapshot()
                    output.append(ResponseShape(principal_id: principal.id, vendor: principal.vendor, source: "engine:native:codex", shape: codexShape(snapshot), error: nil))
                case "antigravity":
                    let snapshot = try await antigravitySnapshot(principal)
                    output.append(ResponseShape(principal_id: principal.id, vendor: principal.vendor, source: snapshot.source, shape: antigravityShape(snapshot), error: nil))
                default: throw EngineError.unsupportedVendor
                }
            } catch {
                    output.append(ResponseShape(principal_id: principal.id, vendor: principal.vendor, source: nil, shape: [], error: redact(error.localizedDescription)))
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
    static func antigravityShape(_ snapshot: AntigravitySnapshotFetch) -> [String] {
        let usage = snapshot.usage
        let named = AntigravitySnapshotWaiter.summaryWindows(in: usage)
        let windows: [(title: String, id: String, window: RateWindow)] = if named.isEmpty {
            [("Gemini", "none", usage.primary), ("Claude/GPT", "none", usage.secondary)]
                .compactMap { title, id, window in window.map { (title, id, $0) } }
        } else {
            named.map { ($0.title, $0.id, $0.window) }
        }
        return ["$: object", "$.source: \(snapshot.source)", "$.payload_kind: \(snapshot.payloadKind.rawValue)", "$.windows: array[\(windows.count)]"]
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

    static func claude(_ principal: Principal) async throws -> [Observation] {
        let credentials = try await ClaudeKeychainReader.load(configDirectory: principal.location)
        guard !credentials.isExpired else { throw EngineError.expiredCredential }
        // ClaudeOAuthUsageFetcher is internal to CodexBarCore at v0.56.4. This mirrors its
        // OAuth-only endpoint and headers, while retaining the access token in memory only.
        let snapshot = try await ClaudeOAuthUsageReader.fetch(accessToken: credentials.accessToken)
        var observations = claudeWindows(principal, meter: "all", windows: [snapshot.fiveHour, snapshot.sevenDay])
        observations += claudeScopedWindows(principal, meter: "fable", window: snapshot.fable)
        observations += claudeScopedWindows(principal, meter: "routines", window: snapshot.routines)
        guard !observations.isEmpty else { throw EngineError.noUsage }
        return observations
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
        let snapshot = try await antigravitySnapshot(principal)
        let observations = antigravityWindows(principal, snapshot: snapshot)
        guard !observations.isEmpty else { throw EngineError.noUsage }
        return observations
    }

    static func antigravitySnapshot(_ principal: Principal) async throws -> AntigravitySnapshotFetch {
        // The engine deliberately has no OAuth fallback. The descriptor's OAuth
        // strategy can start at fetchAvailableModels, which is availability not
        // capacity. Query `agy`'s local HTTPS endpoint and wait for its summary.
        return try await AgyBootstrap.fetch(binaryHint: principal.location)
    }

    static func antigravityWindows(_ principal: Principal, snapshot: AntigravitySnapshotFetch) -> [Observation] {
        let usage = snapshot.usage
        let source = "engine:native:antigravity:\(snapshot.source)"
        if AntigravitySnapshotWaiter.isAvailabilityOnly(snapshot) {
            return AntigravitySnapshotWaiter.expectedMeters.sorted().flatMap { meter in
                [300, AntigravitySnapshotWaiter.weeklyMinutes].map {
                    failedAntigravityWindow(principal, meter: meter, minutes: $0, source: source,
                        reason: "availability-only payload; quota summary not served (source: \(snapshot.source))")
                }
            }
        }
        let summaryWindows = AntigravitySnapshotWaiter.summaryWindows(in: usage)
        var output: [Observation] = []

        if summaryWindows.isEmpty {
            output += windows(principal, meter: "gemini", windows: [usage.primary], source: source)
            output += windows(principal, meter: "claude-gpt", windows: [usage.secondary], source: source)
        } else {
            for named in summaryWindows where named.usageKnown {
                guard let meter = AntigravitySnapshotWaiter.meter(for: named) else { continue }
                output += windows(principal, meter: meter, windows: [named.window], source: source)
            }
        }

        // A partial status payload must not allow an old weekly observation to
        // masquerade as current. Emit the missing per-group weekly lane as a
        // failed observation so Tally's fail-closed status becomes UNKNOWN.
        let presentWeeklyMeters = Set(summaryWindows
            .filter { $0.window.windowMinutes == AntigravitySnapshotWaiter.weeklyMinutes && $0.usageKnown }
            .compactMap(AntigravitySnapshotWaiter.meter(for:)))
        for meter in AntigravitySnapshotWaiter.expectedMeters.sorted() where !presentWeeklyMeters.contains(meter) {
            output.append(failedWeeklyWindow(principal, meter: meter, source: source))
        }
        return output
    }

    static func claudeWindows(_ principal: Principal, meter: String, windows: [ClaudeUsageWindow?]) -> [Observation] {
        windows.compactMap { value in
            guard let value else { return nil }
            if !value.isEnforced {
                return notEnforcedWindow(principal, meter: meter, minutes: value.minutes ?? 10_080, source: "engine:native:claude", reason: "vendor marks scoped limit inactive")
            }
            guard let percent = value.percent else { return nil }
            return observation(
                principal, meter: meter,
                quantity: Quantity(used: percent, limit: 100, remaining: max(0, 100 - percent), unit: "percent"),
                reset: value.resetsAt, observed: Date(), source: "engine:native:claude",
                window: Window(kind: value.resetsAt == nil ? "rolling" : "fixed", minutes: value.minutes, enforcement: "hard"))
        }
    }

    /// Scoped meters are an allowance only when the response names one. Its
    /// absence is a successful vendor response, never a per-meter read error.
    static func claudeScopedWindows(_ principal: Principal, meter: String, window: ClaudeUsageWindow?) -> [Observation] {
        guard let window else {
            return [notEnforcedWindow(principal, meter: meter, minutes: 10_080, source: "engine:native:claude", reason: "no scoped limit in response")]
        }
        return claudeWindows(principal, meter: meter, windows: [window])
    }

    static func windows(_ principal: Principal, meter: String, windows: [RateWindow?], source: String, metadata: ObservationMetadata? = nil) -> [Observation] {
        windows.compactMap { value in
            guard let value, !value.isSyntheticPlaceholder else { return nil }
            if isAvailabilityLike(value) {
                return estimatedWindow(principal, meter: meter, value: value, source: source,
                    reason: "zero usage without reset evidence", metadata: metadata)
            }
            return observation(principal, meter: meter, quantity: Quantity(used: value.usedPercent, limit: 100, remaining: value.remainingPercent, unit: "percent"), reset: value.resetsAt, observed: Date(), source: source, window: Window(kind: value.resetsAt == nil ? "rolling" : "fixed", minutes: value.windowMinutes, enforcement: "hard"), metadata: metadata)
        }
    }

    /// A zero with neither a reset timestamp nor vendor reset prose is a useful
    /// hint, but not vendor-confirmed capacity. Keep this provider-neutral so a
    /// future adapter cannot accidentally turn the same placeholder into fresh.
    static func isAvailabilityLike(_ value: RateWindow) -> Bool {
        value.usedPercent == 0 && value.resetsAt == nil && value.resetDescription?
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
    }

    static func estimatedWindow(_ principal: Principal, meter: String, value: RateWindow, source: String, reason: String, metadata: ObservationMetadata?) -> Observation {
        let now = iso(Date())!
        return Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: Window(kind: value.resetsAt == nil ? "rolling" : "fixed", minutes: value.windowMinutes, enforcement: "hard"), quantity: Quantity(used: value.usedPercent, limit: 100, remaining: value.remainingPercent, unit: "percent"), resets_at: iso(value.resetsAt), observed_at: now, fetched_at: now, source: source, truth: "estimated", freshness: "stale", confidence: 0.4, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: reason, metadata: metadata)
    }

    static func observation(_ principal: Principal, meter: String, quantity: Quantity, reset: Date?, observed: Date, source: String, window: Window?, metadata: ObservationMetadata? = nil) -> Observation {
        Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: window, quantity: quantity, resets_at: iso(reset), observed_at: iso(observed)!, fetched_at: iso(Date())!, source: source, truth: "official", freshness: "fresh", confidence: 1, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: nil, metadata: metadata)
    }

    static func notEnforcedWindow(_ principal: Principal, meter: String, minutes: Int, source: String, reason: String, metadata: ObservationMetadata? = nil) -> Observation {
        let now = iso(Date())!
        return Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: Window(kind: "rolling", minutes: minutes, enforcement: "hard"), quantity: nil, resets_at: nil, observed_at: now, fetched_at: now, source: source, truth: "official", freshness: "not_enforced", confidence: 1, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: reason, metadata: metadata)
    }

    static func failedWeeklyWindow(_ principal: Principal, meter: String, source: String) -> Observation {
        failedAntigravityWindow(principal, meter: meter, minutes: AntigravitySnapshotWaiter.weeklyMinutes, source: source, reason: "quota summary not ready")
    }

    static func failedAntigravityWindow(_ principal: Principal, meter: String, minutes: Int, source: String, reason: String) -> Observation {
        let now = iso(Date())!
        return Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: Window(kind: "fixed", minutes: minutes, enforcement: "hard"), quantity: nil, resets_at: nil, observed_at: now, fetched_at: now, source: source, truth: "estimated", freshness: "failed", confidence: 0, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: reason, metadata: nil)
    }

    static func failed(principal: Principal, meters: [String], error: Error) -> [Observation] {
        let now = iso(Date())!
        return meters.map { meter in Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: nil, quantity: nil, resets_at: nil, observed_at: now, fetched_at: now, source: "engine:native", truth: "estimated", freshness: "failed", confidence: 0, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: redact(error.localizedDescription), metadata: nil) }
    }

    static func meterNames(for vendor: String) -> [String] {
        switch vendor { case "claude": ["all", "fable", "routines"]; case "codex": ["main", "spark", "credits"]; case "antigravity": ["gemini", "claude-gpt"]; default: ["unknown"] }
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

enum EngineError: LocalizedError { case unsupportedVendor, expiredCredential, noUsage, claudeUsageUnavailable
    var errorDescription: String? { switch self { case .unsupportedVendor: "unsupported vendor"; case .expiredCredential: "expired, run claude to refresh"; case .noUsage: "provider returned no quota windows"; case .claudeUsageUnavailable: "Claude OAuth usage unavailable" } }
}
