import Foundation
import Security
import CryptoKit

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Reads the Keychain credential and uses it in this process only. Stdout is
/// strictly the bounded, secret-free usage JSON response.
@main
struct HeadroomClaudeProbe {
    static func main() {
        let args = CommandLine.arguments
        guard args.count == 3, args[1] == "--config-dir" else { exit(2) }
        let directory = URL(fileURLWithPath: args[2]).standardizedFileURL.path
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrAccount: NSUserName(),
            kSecAttrService: serviceName(directory), kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let credentialData = result as? Data else {
            if status == errSecAuthFailed || status == errSecUserCanceled { fail("HEADROOM_PROBE_KEYCHAIN_DENIED", 3) }
            fail("HEADROOM_PROBE_NO_CREDENTIALS", 1)
        }
        guard let token = token(credentialData) else { fail("HEADROOM_PROBE_NO_CREDENTIALS", 1) }
        var request = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/usage")!)
        request.httpMethod = "GET"; request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.setValue("claude-code/2.1.0", forHTTPHeaderField: "User-Agent")
        let wait = DispatchSemaphore(value: 0)
        let resultBox = ResultBox()
        URLSession.shared.dataTask(with: request) { data, response, _ in
            resultBox.status = (response as? HTTPURLResponse)?.statusCode ?? 0
            resultBox.ok = resultBox.status == 200
            resultBox.data = data; wait.signal()
        }.resume()
        guard wait.wait(timeout: .now() + 12) == .success else { fail("HEADROOM_PROBE_TIMEOUT", 4) }
        if resultBox.status == 401 { fail("HEADROOM_PROBE_EXPIRED", 1) }
        guard resultBox.ok, let data = resultBox.data, data.count <= 1_048_576, safeUsageJSON(data) else { fail("HEADROOM_PROBE_USAGE_FAILED", 1) }
        FileHandle.standardOutput.write(data)
    }

    private static func fail(_ marker: String, _ code: Int32) -> Never { fputs("\(marker)\n", stderr); exit(code) }
    private static func token(_ data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let oauth = root["claudeAiOauth"] as? [String: Any], let token = oauth["accessToken"] as? String, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return token
    }
    private static func safeUsageJSON(_ data: Data) -> Bool {
        guard let root = try? JSONSerialization.jsonObject(with: data) else { return false }
        return check(root, depth: 0)
    }
    private static func check(_ value: Any, depth: Int) -> Bool {
        guard depth <= 32 else { return false }
        if let string = value as? String { return string.lengthOfBytes(using: .utf8) <= 65_536 }
        if let array = value as? [Any] { return array.count <= 10_000 && array.allSatisfy { check($0, depth: depth + 1) } }
        if let object = value as? [String: Any] {
            return object.allSatisfy { key, item in
                let key = key.lowercased()
                return !key.contains("token") && !key.contains("refresh") && !key.contains("email") && check(item, depth: depth + 1)
            }
        }
        return true
    }
    private static func serviceName(_ directory: String) -> String {
        let defaultDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude").standardizedFileURL.path
        guard directory != defaultDirectory else { return "Claude Code-credentials" }
        let digest = SHA256.hash(data: Data(directory.utf8)).map { String(format: "%02x", $0) }.joined()
        return "Claude Code-credentials-\(digest.prefix(8))"
    }
}

private final class ResultBox: @unchecked Sendable {
    var data: Data?
    var ok = false
    var status = 0
}
