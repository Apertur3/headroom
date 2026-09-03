import Foundation
import Security

@main
struct HeadroomKeychain {
    static func main() {
        guard CommandLine.arguments.count == 2 else { exit(2) }
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: NSUserName(),
            kSecAttrService: CommandLine.arguments[1],
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { exit(1) }
        FileHandle.standardOutput.write(data)
    }
}
