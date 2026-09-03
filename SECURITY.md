# Security and threat model

Headroom reads private usage endpoints with the user's own credentials and runs a local daemon.
The threat model is a single-user machine; the assets are the user's OAuth tokens and session
cookies, which unlock paid subscriptions.

## Rules the code must satisfy

1. **No secret on disk in plaintext, ever.** Credentials are read at call time from each account's
   own store (macOS Keychain, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`) and dropped
   after the request. Headroom has no credential store of its own and never mirrors tokens into
   config files (CodexBar's `tokenAccounts` path is deliberately not used).
2. **No secret in output.** Logs, crash dumps, JSON output and history redact tokens, cookies,
   Authorization headers and, by default, email addresses.
3. **Local-only surface.** The daemon listens on a mode-0600 Unix socket on macOS and Linux, or
   a per-user named pipe on Windows whose ACL is restricted to the current process user. Headroom
   has no TCP listener.
4. **Polite polling.** Vendor polls are rate-limited and jittered so Headroom never triggers a
   lockout or a bot-defense challenge; a 401/403/429 backs off exponentially and is surfaced,
   never retried in a tight loop.
5. **Verified engine.** The CodexBarCLI binary is pinned by version and SHA-256 and downloaded
   over HTTPS from the upstream release; a mismatch aborts.
6. **No debug surfaces in release.** No debug endpoints, no source maps, no verbose stack traces
   to clients.
7. **Audit log.** Every query to the daemon and every vendor poll is logged with caller, time and
   outcome, without payload secrets.
8. **Dependencies pinned and audited.** Lockfile committed, `npm audit` in CI, minimal dependency
   set.
9. **No telemetry.** Headroom phones home to nothing.
10. **Keychain ACL identity.** On macOS, Claude credentials are read by the signed
    `headroom-keychain` helper. Choose “Always Allow” for that helper in a Keychain
    prompt, never for the shared `security` command. If the helper is unavailable,
    Headroom prints a warning before using the weaker fallback.
11. **Outbound allowlist.** Credential-backed requests only target
    `api.anthropic.com`, `chatgpt.com`, and configured local base URLs. Proxy
    environment variables are ignored unless a `proxy` value is explicitly set in
    `policy.toml`.

## Out of scope

Web-app classes (SQL/NoSQL injection, CSRF, XSS, payments, tenant isolation) do not apply to a
local single-user daemon and are not defended against beyond rule 3.

## Reporting

Open a private security advisory on the GitHub repo.
