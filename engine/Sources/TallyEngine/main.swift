import CodexBarCore
import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

let engineVersion = "0.1.0"
let upstreamVersion = "v0.56.4"

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
}

@main
struct TallyEngine {
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

    // The record load is intentionally non-refreshing. It opens CodexBarCore's profile-aware
    // Keychain path on macOS, then the OAuth-only fetcher uses that in-memory record.
    static func claude(_ principal: Principal) async throws -> [Observation] {
        var environment = ProcessInfo.processInfo.environment
        environment[ClaudeConfigPaths.configDirectoryEnvironmentKey] = principal.location
        environment[ClaudeConfigPaths.secureStorageDirectoryEnvironmentKey] = principal.location
        // CodexBarCore makes this an explicit, durable user-consent gate; setting it here is the
        // Tally CLI's requested opt-in, never a bypass of the macOS ACL prompt.
        UserDefaults(suiteName: "com.steipete.codexbar")?.set(
            true, forKey: ClaudeOAuthDirectKeychainReadConsent.userDefaultsKey)
        let record = try ClaudeOAuthCredentialsStore.loadRecord(
            environment: environment,
            allowKeychainPrompt: true,
            respectKeychainPromptCooldown: false,
            allowClaudeKeychainRepairWithoutPrompt: false)
        guard !record.credentials.isExpired else { throw EngineError.expiredCredential }
        let fetcher = ClaudeUsageFetcher(
            browserDetection: BrowserDetection(), environment: environment, runtime: .app,
            dataSource: .oauth, oauthSafeCredentialSourcesOnly: true)
        let snapshot = try await ProviderInteractionContext.$current.withValue(.userInitiated) {
            try await fetcher.loadLatestUsage()
        }
        var observations = windows(principal, meter: "all", windows: [snapshot.primary, snapshot.secondary], source: "engine:native:claude")
        for extra in snapshot.extraRateWindows {
            let name = extra.id.lowercased() + " " + extra.title.lowercased()
            if name.contains("fable") { observations += windows(principal, meter: "fable", windows: [extra.window], source: "engine:native:claude") }
            if name.contains("routine") { observations += windows(principal, meter: "routines", windows: [extra.window], source: "engine:native:claude") }
        }
        guard !observations.isEmpty else { throw EngineError.noUsage }
        return observations
    }

    static func codex(_ principal: Principal) async throws -> [Observation] {
        var environment = ProcessInfo.processInfo.environment
        environment["CODEX_HOME"] = principal.location
        let snapshot = try await UsageFetcher(environment: environment).loadLatestCLIAccountSnapshot()
        var observations = windows(principal, meter: "main", windows: [snapshot.usage?.primary, snapshot.usage?.secondary], source: "engine:native:codex")
        for extra in snapshot.usage?.extraRateWindows ?? [] where extra.title.localizedCaseInsensitiveContains("spark") {
            observations += windows(principal, meter: "spark", windows: [extra.window], source: "engine:native:codex")
        }
        if let credit = snapshot.credits?.codexCreditLimit {
            observations.append(observation(principal, meter: "credits", quantity: Quantity(used: credit.used, limit: credit.limit, remaining: credit.remaining, unit: "credits"), reset: credit.resetsAt, observed: credit.updatedAt, source: "engine:native:codex", window: nil))
        }
        guard !observations.isEmpty else { throw EngineError.noUsage }
        return observations
    }

    static func antigravity(_ principal: Principal) async throws -> [Observation] {
        // `location` is an agy executable/path hint for the supervisor in a later slice. The core
        // probe deliberately discovers the signed-in local app/agy server instead of reading OAuth files.
        let status = try await AntigravityStatusProbe().fetch()
        let usage = try status.toUsageSnapshot()
        let observations = windows(principal, meter: "gemini", windows: [usage.primary], source: "engine:native:antigravity")
            + windows(principal, meter: "claude-gpt", windows: [usage.secondary], source: "engine:native:antigravity")
        guard !observations.isEmpty else { throw EngineError.noUsage }
        return observations
    }

    static func windows(_ principal: Principal, meter: String, windows: [RateWindow?], source: String) -> [Observation] {
        windows.compactMap { value in
            guard let value, !value.isSyntheticPlaceholder else { return nil }
            return observation(principal, meter: meter, quantity: Quantity(used: value.usedPercent, limit: 100, remaining: value.remainingPercent, unit: "percent"), reset: value.resetsAt, observed: Date(), source: source, window: Window(kind: value.resetsAt == nil ? "rolling" : "fixed", minutes: value.windowMinutes, enforcement: "hard"))
        }
    }

    static func observation(_ principal: Principal, meter: String, quantity: Quantity, reset: Date?, observed: Date, source: String, window: Window?) -> Observation {
        Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: window, quantity: quantity, resets_at: iso(reset), observed_at: iso(observed)!, fetched_at: iso(Date())!, source: source, truth: "official", freshness: "fresh", confidence: 1, adapter_version: engineVersion, upstream_schema_version: upstreamVersion, reason: nil)
    }

    static func failed(principal: Principal, meters: [String], error: Error) -> [Observation] {
        let now = iso(Date())!
        return meters.map { meter in Observation(principal_id: principal.id, meter_id: "\(principal.id):\(meter)", window: nil, quantity: nil, resets_at: nil, observed_at: now, fetched_at: now, source: "engine:native", truth: "estimated", freshness: "failed", confidence: 0, adapter_version: engineVersion, upstream_schema_version: upstreamVersion, reason: redact(error.localizedDescription)) }
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

enum EngineError: LocalizedError { case unsupportedVendor, expiredCredential, noUsage
    var errorDescription: String? { switch self { case .unsupportedVendor: "unsupported vendor"; case .expiredCredential: "credential expired; refresh it with the vendor CLI"; case .noUsage: "provider returned no quota windows" } }
}
