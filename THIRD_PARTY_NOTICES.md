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

## Trademarks and affiliation

Headroom is an independent open source project. It is not affiliated with, sponsored by or
endorsed by Anthropic, OpenAI, Google, xAI or Moonshot AI. Claude, Claude Code, Codex, ChatGPT,
Antigravity, Gemini, Grok and Kimi are trademarks of their respective owners. Headroom uses these
names only to identify the services it reads (nominative use) and ships no vendor logos.
