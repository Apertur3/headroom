import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct ClaudeUsageWindow: Sendable {
    let percent: Double?
    let resetsAt: Date?
    let minutes: Int?
    /// False is a vendor-confirmed inactive scoped allowance, not a failed read.
    let isEnforced: Bool
}

struct ClaudeUsageSnapshot: Sendable {
    let fiveHour: ClaudeUsageWindow?
    let sevenDay: ClaudeUsageWindow?
    let fable: ClaudeUsageWindow?
    let routines: ClaudeUsageWindow?
}

/// Equivalent to CodexBarCore's internal ClaudeOAuthUsageFetcher at v0.56.4.
/// It intentionally has no refresh path and emits no response body in errors.
enum ClaudeOAuthUsageReader {
    static func fetch(accessToken: String) async throws -> ClaudeUsageSnapshot {
        try parse(await response(accessToken: accessToken))
    }

    /// Debug-only structural view. It reports keys/kinds plus a tiny allowlist
    /// of enum-like limit descriptors; quota values, headers and credentials
    /// are never included.
    static func shape(accessToken: String) async throws -> [String] {
        skeleton(try JSONSerialization.jsonObject(with: await response(accessToken: accessToken)))
    }

    private static func response(accessToken: String) async throws -> Data {
        guard let url = URL(string: "https://api.anthropic.com/api/oauth/usage") else {
            throw EngineError.claudeUsageUnavailable
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.setValue("claude-code/2.1.0", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw EngineError.claudeUsageUnavailable }
            return data
        } catch is EngineError {
            throw EngineError.claudeUsageUnavailable
        } catch {
            throw EngineError.claudeUsageUnavailable
        }
    }

    private static func skeleton(_ value: Any, path: String = "$") -> [String] {
        if let object = value as? [String: Any] {
            return ["\(path): object"] + object.keys.sorted().flatMap { key in skeleton(object[key] as Any, path: "\(path).\(key)") }
        }
        if let array = value as? [Any] {
            let itemShapes = array.prefix(3).flatMap { skeleton($0, path: "\(path)[]") }
            return ["\(path): array[\(array.count)]"] + Array(Set(itemShapes)).sorted()
        }
        if value is NSNull { return ["\(path): null"] }
        if let value = value as? Bool { return [shapeLine(path, kind: "bool", value: value ? "true" : "false")] }
        if value is NSNumber { return ["\(path): number"] }
        if let value = value as? String { return [shapeLine(path, kind: "string", value: value)] }
        return ["\(path): unknown"]
    }

    private static func shapeLine(_ path: String, kind: String, value: String) -> String {
        let allowed = ["$.limits[].kind", "$.limits[].group", "$.limits[].severity", "$.limits[].is_active", "$.limits[].scope.model.display_name", "$.limits[].scope.surface"]
        guard allowed.contains(path) else { return "\(path): \(kind)" }
        // Allowed values are non-secret descriptors. Escape controls so a remote
        // response cannot forge extra diagnostic lines.
        let escaped = value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "\\r")
        return "\(path): \(kind) = \(escaped)"
    }

    static func parse(_ data: Data) throws -> ClaudeUsageSnapshot {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw EngineError.claudeUsageUnavailable
        }
        // `five_hour.utilization` and `seven_day.utilization` are the primary
        // all-meter fields. `percent` is retained only for older responses.
        let fiveHour = window(root["five_hour"], minutes: 300)
        let sevenDay = window(root["seven_day"], minutes: 10_080)
        var fable: ClaudeUsageWindow?
        var routines: ClaudeUsageWindow?

        for (key, value) in root where key.lowercased().hasPrefix("seven_day_") {
            let lower = key.lowercased()
            if lower.contains("fable") { fable = fable ?? window(value, minutes: 10_080) }
            if lower.contains("routine") || lower.contains("cowork") { routines = routines ?? window(value, minutes: 10_080) }
        }
        if let limits = root["limits"] as? [[String: Any]] {
            for limit in limits where (limit["kind"] as? String)?.lowercased().contains("scoped") == true {
                guard let scoped = scopedWindow(limit) else { continue }
                // The OAuth response identifies Fable as scope.model.display_name. Other
                // active weekly-scoped limits are the routines/Cowork allowance. Do not
                // depend on the legacy top-level seven_day_* field names: they disappear
                // for these scoped meters on current Claude accounts.
                let scope = limit["scope"] as? [String: Any]
                let model = scope?["model"] as? [String: Any]
                let name = (model?["display_name"] as? String ?? model?["name"] as? String ?? "").lowercased()
                if name.contains("fable") { fable = preferred(fable, scoped) }
                else { routines = preferred(routines, scoped) }
            }
        }
        return ClaudeUsageSnapshot(fiveHour: fiveHour, sevenDay: sevenDay, fable: fable, routines: routines)
    }

    private static func window(_ value: Any?, minutes: Int?) -> ClaudeUsageWindow? {
        guard let object = value as? [String: Any] else { return nil }
        let raw = (object["utilization"] as? NSNumber)?.doubleValue ?? (object["percent"] as? NSNumber)?.doubleValue
        guard let percent = raw, percent.isFinite else { return nil }
        return ClaudeUsageWindow(percent: min(100, max(0, percent)), resetsAt: date(object["resets_at"]), minutes: minutes, isEnforced: true)
    }

    private static func scopedWindow(_ value: [String: Any]) -> ClaudeUsageWindow? {
        let active = (value["is_active"] as? Bool) != false
        if !active { return ClaudeUsageWindow(percent: nil, resetsAt: date(value["resets_at"]), minutes: 10_080, isEnforced: false) }
        let raw = (value["utilization"] as? NSNumber)?.doubleValue ?? (value["percent"] as? NSNumber)?.doubleValue
        guard let percent = raw, percent.isFinite else { return nil }
        return ClaudeUsageWindow(percent: min(100, max(0, percent)), resetsAt: date(value["resets_at"]), minutes: 10_080, isEnforced: true)
    }

    /// A positive/current scope wins over a duplicate inactive legacy entry.
    private static func preferred(_ existing: ClaudeUsageWindow?, _ candidate: ClaudeUsageWindow) -> ClaudeUsageWindow {
        guard let existing else { return candidate }
        return candidate.isEnforced || !existing.isEnforced ? candidate : existing
    }

    private static func date(_ value: Any?) -> Date? {
        guard let string = value as? String, !string.isEmpty else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = formatter.date(from: string) { return parsed }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }
}
