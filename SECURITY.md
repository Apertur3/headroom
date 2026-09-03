# Security and threat model

Tally reads private usage endpoints with the user's own credentials and runs a local daemon.
The threat model is a single-user machine; the assets are the user's OAuth tokens and session
cookies, which unlock paid subscriptions.

## Rules the code must satisfy

1. **No secret on disk in plaintext, ever.** Credentials are read at call time from each account's
   own store (macOS Keychain, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`) and dropped
   after the request. Tally has no credential store of its own and never mirrors tokens into
   config files (CodexBar's `tokenAccounts` path is deliberately not used).
2. **No secret in output.** Logs, crash dumps, JSON output and history redact tokens, cookies,
   Authorization headers and, by default, email addresses.
3. **Local-only surface.** The daemon listens on a Unix socket with mode 0600. TCP is opt-in,
   loopback only, and requires a bearer token stored in the Keychain.
4. **Polite polling.** Vendor polls are rate-limited and jittered so Tally never triggers a
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
9. **No telemetry.** Tally phones home to nothing.

## Out of scope

Web-app classes (SQL/NoSQL injection, CSRF, XSS, payments, tenant isolation) do not apply to a
local single-user daemon and are not defended against beyond rule 3.

## Reporting

Open a private security advisory on the GitHub repo.
