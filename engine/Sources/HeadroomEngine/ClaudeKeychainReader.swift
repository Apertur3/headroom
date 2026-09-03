import Foundation
import Security

#if os(macOS)
import Darwin
#endif

#if canImport(CryptoKit)
import CryptoKit
#elseif canImport(Crypto)
import Crypto
#endif

/// Reads Claude Code's credential at its documented, config-directory-scoped location.
/// Secrets are returned only in memory and are deliberately never included in errors.
enum ClaudeKeychainReader {
    struct Credentials: Sendable {
        let accessToken: String
        let expiresAt: Date

        var isExpired: Bool { Date() >= expiresAt }
    }

    private enum ReaderError: LocalizedError {
        case unavailable
        case invalid

        var errorDescription: String? {
            switch self {
            case .unavailable: "OAuth credentials unavailable"
            case .invalid: "OAuth credentials invalid"
            }
        }
    }

    static func load(configDirectory: String) async throws -> Credentials {
        #if os(macOS)
        let payload = try await readKeychain(configDirectory: configDirectory)
        #else
        let path = URL(fileURLWithPath: normalizedDirectory(configDirectory))
            .appendingPathComponent(".credentials.json")
        let payload: Data
        do { payload = try Data(contentsOf: path) }
        catch { throw ReaderError.unavailable }
        #endif
        return try parse(payload)
    }

    static func serviceName(configDirectory: String) -> String {
        let directory = normalizedDirectory(configDirectory)
        let defaultDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude", isDirectory: true)
            .standardizedFileURL.path
        guard directory != defaultDirectory else { return "Claude Code-credentials" }
        return "Claude Code-credentials-\(sha256Hex(directory).prefix(8))"
    }

    static func parse(_ payload: Data) throws -> Credentials {
        struct Root: Decodable { let claudeAiOauth: OAuth? }
        struct OAuth: Decodable {
            let accessToken: String?
            let expiresAt: Double?
        }
        guard let oauth = try? JSONDecoder().decode(Root.self, from: payload).claudeAiOauth,
              let token = oauth.accessToken?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty,
              let expiresAt = oauth.expiresAt,
              expiresAt.isFinite
        else { throw ReaderError.invalid }
        return Credentials(accessToken: token, expiresAt: Date(timeIntervalSince1970: expiresAt / 1_000))
    }

    private static func normalizedDirectory(_ value: String) -> String {
        let expanded: String
        if value == "~" { expanded = FileManager.default.homeDirectoryForCurrentUser.path }
        else if value.hasPrefix("~/") {
            expanded = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(String(value.dropFirst(2))).path
        } else { expanded = value }
        return URL(fileURLWithPath: expanded).standardizedFileURL.path
    }

    #if os(macOS)
    private static func readKeychain(configDirectory: String) async throws -> Data {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: NSUserName(),
            kSecAttrService: serviceName(configDirectory: configDirectory),
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { throw ReaderError.unavailable }
        return data
    }
    #endif

    private static func sha256Hex(_ value: String) -> String {
        #if canImport(CryptoKit) || canImport(Crypto)
        return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
        #else
        // SwiftPM's CodexBarCore dependency provides Crypto on supported targets.
        return ""
        #endif
    }
}
