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

@main
struct TallyEngine {
    static let engineVersion = "0.1.0"
    static let upstreamVersion = "v0.56.4"

    static func main() async {
        guard CommandLine.arguments.count == 4,
              CommandLine.arguments[1] == "observe",
              CommandLine.arguments[2] == "--principals"
        else {
            FileHandle.standardError.write(Data("Usage: tally-engine observe --principals <path-to-json>\n".utf8))
            exit(2)
        }

        let observations: [Observation]
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3]))
            observations = await observe(try JSONDecoder().decode([Principal].self, from: data))
        } catch {
            observations = failed(
                principal: Principal(id: "invalid-input", vendor: "unknown", location: ""),
                meters: ["unknown"],
                error: error)
        }
        // The Core owns its spawned `agy` process. Always reset that session before this
        // one-shot engine exits; user/IDE-owned processes are never part of that session.
        await ProviderCLISessionLifecycle.shutdownPersistentSessions()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let output = (try? encoder.encode(observations)) ?? Data("[]".utf8)
        FileHandle.standardOutput.write(output)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(observations.contains { $0.freshness == "fresh" } ? 0 : 3)
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

    static func claude(_ principal: Principal) async throws -> [Observation] {
        let credentials = try await ClaudeKeychainReader.load(configDirectory: principal.location)
        guard !credentials.isExpired else { throw EngineError.expiredCredential }
        // ClaudeOAuthUsageFetcher is internal to CodexBarCore at v0.56.4. This mirrors its
        // OAuth-only endpoint and headers, while retaining the access token in memory only.
        let snapshot = try await ClaudeOAuthUsageReader.fetch(accessToken: credentials.accessToken)
        var observations = claudeWindows(principal, meter: "all", windows: [snapshot.fiveHour, snapshot.sevenDay])
        observations += claudeWindows(principal, meter: "fable", windows: [snapshot.fable])
        observations += claudeWindows(principal, meter: "routines", windows: [snapshot.routines])
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
        // Preserve that vendor fact as a failed datum: omitting it would make a
        // consumer mistake an unknown hard cap for available capacity.
        if snapshot.usage?.primary == nil {
            observations.append(failedWindow(principal, meter: "main", minutes: 300, source: "engine:native:codex", reason: "vendor returned no 5-hour window", metadata: metadata))
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
        // Prefer a user-owned app/IDE server. If none exists, boot agy under a
        // PTY and wait for a listening local port before asking the Core to read it.
        let status: AntigravityStatusSnapshot
        do {
            status = try await AntigravityStatusProbe().fetch()
        } catch AntigravityStatusProbeError.notRunning {
            status = try await AgyBootstrap.fetch(binaryHint: principal.location)
        }
        let usage = try status.toUsageSnapshot()
        let observations = windows(principal, meter: "gemini", windows: [usage.primary], source: "engine:native:antigravity")
            + windows(principal, meter: "claude-gpt", windows: [usage.secondary], source: "engine:native:antigravity")
        guard !observations.isEmpty else { throw EngineError.noUsage }
        return observations
    }

    static func claudeWindows(_ principal: Principal, meter: String, windows: [ClaudeUsageWindow?]) -> [Observation] {
        windows.compactMap { value in
            guard let value else { return nil }
            return observation(
                principal, meter: meter,
                quantity: Quantity(used: value.percent, limit: 100, remaining: max(0, 100 - value.percent), unit: "percent"),
                reset: value.resetsAt, observed: Date(), source: "engine:native:claude",
                window: Window(kind: value.resetsAt == nil ? "rolling" : "fixed", minutes: value.minutes, enforcement: "hard"))
        }
    }

    static func windows(_ principal: Principal, meter: String, windows: [RateWindow?], source: String, metadata: ObservationMetadata? = nil) -> [Observation] {
        windows.compactMap { value in
            guard let value, !value.isSyntheticPlaceholder else { return nil }
            return observation(principal, meter: meter, quantity: Quantity(used: value.usedPercent, limit: 100, remaining: value.remainingPercent, unit: "percent"), reset: value.resetsAt, observed: Date(), source: source, window: Window(kind: value.resetsAt == nil ? "rolling" : "fixed", minutes: value.windowMinutes, enforcement: "hard"), metadata: metadata)
        }
    }

    static func observation(_ principal: Principal, meter: String, quantity: Quantity, reset: Date?, observed: Date, source: String, window: Window?, metadata: ObservationMetadata? = nil) -> Observation {
        Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: window, quantity: quantity, resets_at: iso(reset), observed_at: iso(observed)!, fetched_at: iso(Date())!, source: source, truth: "official", freshness: "fresh", confidence: 1, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: nil, metadata: metadata)
    }

    static func failedWindow(_ principal: Principal, meter: String, minutes: Int, source: String, reason: String, metadata: ObservationMetadata? = nil) -> Observation {
        let now = iso(Date())!
        return Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: Window(kind: "rolling", minutes: minutes, enforcement: "hard"), quantity: nil, resets_at: nil, observed_at: now, fetched_at: now, source: source, truth: "official", freshness: "failed", confidence: 1, adapter_version: Self.engineVersion, upstream_schema_version: Self.upstreamVersion, reason: reason, metadata: metadata)
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
