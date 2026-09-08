import Foundation
import Security
import CryptoKit

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The only host this probe will ever hand the bearer token to, and the only
/// host a successful response is trusted to have come from.
let anthropicUsageHost = "api.anthropic.com"

/// The Apple-signed tool this probe reads the credential through.
///
/// Claude Code 2.1.263 rewrites `Claude Code-credentials` (and the
/// per-profile `Claude Code-credentials-<hash>` items) with an access list
/// that admits Apple-signed tools but not third-party applications. A direct
/// `SecItemCopyMatching` with `kSecReturnData` from this probe therefore
/// comes back `errSecItemNotFound` even from the user's own Terminal, with no
/// dialog offered at all, while `/usr/bin/security find-generic-password -w`
/// returns the secret with exit 0 and no dialog, even from a sandboxed shell.
/// So the framework read stays only as a silent first attempt, and this is
/// the path that actually answers. Absolute path, spawned with an argument
/// vector and never through a shell.
let securityToolPath = "/usr/bin/security"

/// `security`'s own exit status for "The specified item could not be found in
/// the keychain": the one failure that means a genuinely absent login rather
/// than a tool that could not do its job.
let securityToolItemNotFoundStatus: Int32 = 44

/// How long `security` gets to answer before the probe gives up on it.
let securityToolTimeoutSeconds = 10.0

/// Nothing larger than this is a Claude credential; a `security` that streams
/// more than this is not answering the question that was asked.
let securityToolOutputCap = 1_048_576

/// What one `security find-generic-password -w` run resolved to. `failed`
/// carries the tool's exit status and nothing else: its output is discarded
/// unread, because the only thing on that stream is the secret itself.
enum SecurityToolOutcome: Equatable {
    case credential(Data)
    case absent
    case failed(Int32)
    case timedOut
    case unusable
}

/// Holds the pipe's read end and the bytes taken from it, so the background
/// read can be handed to a Sendable closure without capturing a FileHandle
/// across the boundary. Stays in memory; nothing here is ever written to disk.
final class SecurityToolOutput: @unchecked Sendable {
    private let handle: FileHandle
    private(set) var data = Data()
    private(set) var overCap = false

    init(_ handle: FileHandle) { self.handle = handle }

    /// Drains the pipe, stopping once more than `cap` bytes have arrived.
    /// Draining rather than waiting for the process first is what keeps a
    /// full pipe buffer from deadlocking the wait below.
    func drain(cap: Int) {
        while true {
            let chunk = handle.availableData
            if chunk.isEmpty { return }
            if data.count + chunk.count > cap { overCap = true; return }
            data.append(chunk)
        }
    }
}

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
        let service = serviceName(directory)
        let account = NSUserName()
        // The framework read first, but only silently: it is the cheaper path
        // on any machine whose item still admits this binary, and on one whose
        // item does not it must fail immediately rather than sit on a dialog.
        // Whatever status it returns is not an answer -- `security` gives the
        // real one below.
        let credentialData = silentKeychainRead(service: service, account: account)
            ?? credentialThroughSecurityTool(service: service, account: account)
        // The item exists and decrypted (either read returned bytes). If its
        // JSON carries no usable OAuth access token, that is Claude Code
        // logged out locally (issue #11) -- a different fix (sign back in)
        // than a genuinely absent item (a first login), so it gets its own
        // marker and exit status rather than folding into
        // HEADROOM_PROBE_NO_CREDENTIALS.
        guard let token = token(credentialData) else { fail("HEADROOM_PROBE_LOGGED_OUT", 6) }
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

    /// The silent first attempt through the Security framework.
    /// `kSecUseAuthenticationUIFail` is what makes it silent: an item this
    /// process may not read fails immediately with a status instead of
    /// offering a dialog, so this can never block a background poll. The
    /// constant is formally deprecated in favour of an LAContext, and is
    /// still the working way to say "never prompt" for a plain
    /// SecItemCopyMatching without linking LocalAuthentication for it. Any
    /// failure at all -- restricted item, absent item, anything else --
    /// simply returns nil and lets the `security` read decide.
    static func silentKeychainRead(service: String, account: String) -> Data? {
        // The legacy Keychain confirmation dialog ("... wants to use your
        // confidential information stored in your keychain") is a different
        // mechanism from kSecUseAuthenticationUI, and only this switches it
        // off. Without it, a probe the item no longer admits does not fail --
        // it hangs on a dialog that a daemon or a sandboxed shell has no way
        // to answer. Left off for the rest of the process: nothing this probe
        // does should ever wait on a person.
        SecKeychainSetUserInteractionAllowed(false)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrAccount: account,
            kSecAttrService: service, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
            kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    /// Reads the credential through `security` and turns anything but a
    /// credential into an exit. An absent item keeps the marker and exit
    /// status it has always had, since the fix (log in) has not changed; a
    /// tool that failed for any other reason gets its own marker and exit
    /// status, carrying `security`'s exit status and never its output.
    static func credentialThroughSecurityTool(service: String, account: String) -> Data {
        switch runSecurityTool(service: service, account: account) {
        case .credential(let data): return data
        case .absent: fail("HEADROOM_PROBE_NO_CREDENTIALS", 1)
        case .failed(let status): fail("HEADROOM_PROBE_SECURITY_TOOL_FAILED exit=\(status)", 7)
        case .timedOut: fail("HEADROOM_PROBE_SECURITY_TOOL_FAILED timeout", 7)
        case .unusable: fail("HEADROOM_PROBE_SECURITY_TOOL_FAILED unavailable", 7)
        }
    }

    /// Spawns `/usr/bin/security find-generic-password -s <service> -a
    /// <account> -w` with an explicit argument vector, never a shell. Its
    /// stdout is captured in memory only; stderr is discarded, so a message
    /// that quoted the item back at us could never reach a log. A run that
    /// has not finished within securityToolTimeoutSeconds is terminated.
    static func runSecurityTool(service: String, account: String) -> SecurityToolOutcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: securityToolPath)
        process.arguments = ["find-generic-password", "-s", service, "-a", account, "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do { try process.run() } catch { return .unusable }
        let output = SecurityToolOutput(pipe.fileHandleForReading)
        let drained = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { output.drain(cap: securityToolOutputCap); drained.signal() }
        guard exited.wait(timeout: .now() + securityToolTimeoutSeconds) == .success else {
            process.terminate()
            return .timedOut
        }
        // The pipe's writer is gone once the process has exited, so the drain
        // above is already finishing; this only collects it.
        _ = drained.wait(timeout: .now() + 2)
        if output.overCap { return .unusable }
        return outcome(status: process.terminationStatus, output: output.data)
    }

    /// Classifies one finished `security` run. Not private: the probe tests
    /// exercise this and passwordFromSecurityOutput below directly, so the
    /// parsing is covered without a real Keychain anywhere near it.
    static func outcome(status: Int32, output: Data) -> SecurityToolOutcome {
        guard status == 0 else { return status == securityToolItemNotFoundStatus ? .absent : .failed(status) }
        guard let password = passwordFromSecurityOutput(output) else { return .absent }
        return .credential(password)
    }

    /// `security ... -w` writes the password followed by one newline. Strips
    /// the trailing line ending (CR and LF both, so a credential is never
    /// corrupted by an unexpected one) and reports nothing usable as nil.
    static func passwordFromSecurityOutput(_ output: Data) -> Data? {
        var bytes = output
        while let last = bytes.last, last == 0x0A || last == 0x0D { bytes.removeLast() }
        return bytes.isEmpty ? nil : bytes
    }
    // Not `private`: HeadroomClaudeProbeTests exercises this directly
    // (@testable import) to cover the HEADROOM_PROBE_LOGGED_OUT guard above
    // without spawning the real binary or touching a Keychain item.
    static func token(_ data: Data) -> String? {
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
