# Third-party notices

Headroom's native macOS reader is built from the dependency revisions recorded in
`engine/Package.resolved`. The full license texts and copyright notices for bundled
components are included in [LICENSE](LICENSE).

| Component | Licence | Use in Headroom |
|---|---|---|
| [CodexBar / CodexBarCore](https://github.com/steipete/CodexBar) | MIT | Native quota sensing and optional upstream CLI |
| [SweetCookieKit](https://github.com/steipete/SweetCookieKit) | MIT | CodexBarCore dependency |
| [QuickJS](https://github.com/steipete/CodexBar/tree/main/Sources/CQuickJS) | MIT | CodexBarCore dependency |
| [Swift Crypto](https://github.com/apple/swift-crypto) | Apache-2.0 | CodexBarCore cryptography dependency; macOS uses system CryptoKit |
| [Swift Log](https://github.com/apple/swift-log) | Apache-2.0 | CodexBarCore logging dependency |

System frameworks are supplied by macOS. Headroom's pace-state and dispatch logic are original
to this project.
