import Foundation
import Security
import CryptoKit

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The only host this probe will ever hand the bearer token to, and the only
/// host a successful response is trusted to have come from.
let anthropicUsageHost = "api.anthropic.com"

/// True only when `url`'s host is exactly `api.anthropic.com`. Used both to
/// build the request and, after the fact, to check where the response
/// actually came from once redirects are refused.
func isAnthropicUsageHost(_ url: URL?) -> Bool {
    url?.host == anthropicUsageHost
}

/// A value containing an email address must never reach stdout, regardless of
/// which JSON key it sits under.
func containsEmailAddress(_ value: String) -> Bool {
    value.range(of: #"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#, options: .regularExpression) != nil
}

/// A value that merely looks like a credential must never reach stdout,
/// regardless of which JSON key it sits under: the key-name filter below
/// (token/refresh/email) only catches a key that says what it is, not a
/// vendor field that happens to carry a stray key/token/JWT as its value.
func containsTokenShapedSecret(_ value: String) -> Bool {
    // Word-boundary prefixes (not a bare substring search) so an unrelated
    // word like "risk-level" does not false-positive on "sk-"; the final
    // alternative is a long unbroken run of base64/hex-alphabet characters,
    // which looks like a key or token even under an unrelated field name.
    let pattern = #"\bsk-ant-[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]+|\bya29\.[A-Za-z0-9._-]+|\bGOCSPX-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+|[A-Za-z0-9+/_=-]{41,}"#
    return value.range(of: pattern, options: .regularExpression) != nil
}

/// Cancels every HTTP redirect and enforces a byte cap while streaming.
/// `URLSession.shared` follows redirects and re-sends the Authorization
/// header to whatever host issued the 3xx; a nil completion here refuses the
/// redirect and the original task fails or resolves to the non-redirected
/// response instead. Driving the request via a data-task delegate (rather
/// than the completion-handler convenience API, whose data/didReceive
/// callbacks Foundation never invokes) means bytes are counted and the task
/// is cancelled the moment the cap is exceeded, instead of buffering a
/// complete response before ever checking its size.
final class RedirectRefusingDelegate: NSObject, URLSessionTaskDelegate, URLSessionDataDelegate, @unchecked Sendable {
    let cap: Int
    private(set) var data = Data()
    private(set) var capExceeded = false
    var onComplete: ((URLResponse?, Error?) -> Void)?

    init(cap: Int = 1_048_576) { self.cap = cap }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        if capExceeded { return }
        data.append(chunk)
        if data.count > cap {
            capExceeded = true
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onComplete?(task.response, error)
    }
}

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
        var request = URLRequest(url: URL(string: "https://\(anthropicUsageHost)/api/oauth/usage")!)
        request.httpMethod = "GET"; request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.setValue("claude-code/2.1.0", forHTTPHeaderField: "User-Agent")
        let wait = DispatchSemaphore(value: 0)
        let resultBox = ResultBox()
        let delegate = RedirectRefusingDelegate()
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        delegate.onComplete = { response, _ in
            let http = response as? HTTPURLResponse
            resultBox.status = http?.statusCode ?? 0
            resultBox.finalURL = http?.url
            resultBox.ok = resultBox.status == 200
            wait.signal()
        }
        session.dataTask(with: request).resume()
        guard wait.wait(timeout: .now() + 12) == .success else { fail("HEADROOM_PROBE_TIMEOUT", 4) }
        // A refused redirect still resolves the task with whatever response the
        // last hop returned; verify the host before trusting anything else about it.
        guard isAnthropicUsageHost(resultBox.finalURL) else { fail("HEADROOM_PROBE_BAD_HOST", 5) }
        if resultBox.status == 401 { fail("HEADROOM_PROBE_EXPIRED", 1) }
        // Distinct markers for 403/429 let the TypeScript adapter propagate a
        // status-carrying reason, so the collector's shared backoff logic
        // treats a probe rate-limit or forbidden response the same way it
        // treats one from any other credentialed vendor call.
        if resultBox.status == 403 { fail("HEADROOM_PROBE_FORBIDDEN", 1) }
        if resultBox.status == 429 { fail("HEADROOM_PROBE_RATE_LIMITED", 1) }
        guard !delegate.capExceeded, resultBox.ok, delegate.data.count <= 1_048_576, safeUsageJSON(delegate.data) else { fail("HEADROOM_PROBE_USAGE_FAILED", 1) }
        FileHandle.standardOutput.write(delegate.data)
    }

    private static func fail(_ marker: String, _ code: Int32) -> Never { fputs("\(marker)\n", stderr); exit(code) }
    private static func token(_ data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let oauth = root["claudeAiOauth"] as? [String: Any], let token = oauth["accessToken"] as? String, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return token
    }
    static func safeUsageJSON(_ data: Data) -> Bool {
        guard let root = try? JSONSerialization.jsonObject(with: data) else { return false }
        return check(root, depth: 0)
    }
    static func check(_ value: Any, depth: Int) -> Bool {
        guard depth <= 32 else { return false }
        if let string = value as? String {
            guard string.lengthOfBytes(using: .utf8) <= 65_536 else { return false }
            return !containsEmailAddress(string) && !containsTokenShapedSecret(string)
        }
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
    var ok = false
    var status = 0
    var finalURL: URL?
}
