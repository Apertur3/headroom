import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct ClaudeUsageWindow: Sendable {
    let percent: Double
    let resetsAt: Date?
    let minutes: Int?
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
            return try parse(data)
        } catch is EngineError {
            throw EngineError.claudeUsageUnavailable
        } catch {
            throw EngineError.claudeUsageUnavailable
        }
    }

    static func parse(_ data: Data) throws -> ClaudeUsageSnapshot {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw EngineError.claudeUsageUnavailable
        }
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
            for limit in limits where limit["kind"] as? String == "weekly_scoped" && limit["is_active"] as? Bool != false {
                guard let scoped = scopedWindow(limit) else { continue }
                let name = (((limit["scope"] as? [String: Any])?["model"] as? [String: Any])?["display_name"] as? String ?? "").lowercased()
                if name.contains("fable") { fable = scoped }
                if name.contains("routine") || name.contains("cowork") { routines = scoped }
            }
        }
        return ClaudeUsageSnapshot(fiveHour: fiveHour, sevenDay: sevenDay, fable: fable, routines: routines)
    }

    private static func window(_ value: Any?, minutes: Int?) -> ClaudeUsageWindow? {
        guard let object = value as? [String: Any] else { return nil }
        let raw = (object["utilization"] as? NSNumber)?.doubleValue ?? (object["percent"] as? NSNumber)?.doubleValue
        guard let percent = raw, percent.isFinite else { return nil }
        return ClaudeUsageWindow(percent: min(100, max(0, percent)), resetsAt: date(object["resets_at"]), minutes: minutes)
    }

    private static func scopedWindow(_ value: [String: Any]) -> ClaudeUsageWindow? {
        guard let percent = (value["percent"] as? NSNumber)?.doubleValue, percent.isFinite else { return nil }
        return ClaudeUsageWindow(percent: min(100, max(0, percent)), resetsAt: date(value["resets_at"]), minutes: 10_080)
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
