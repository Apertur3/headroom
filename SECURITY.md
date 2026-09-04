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
3. **Local-only surface.** The daemon listens on a mode-0600 Unix socket on macOS and Linux. On
   Windows Node cannot supply an explicit pipe DACL through its public API, so a random per-daemon
   session token is stored mode 0600 under `HEADROOM_HOME`; clients present it on every request and
   verify the HMAC-signed health response. Headroom has no TCP listener.
4. **Polite polling.** Vendor polls are rate-limited and jittered so Headroom never triggers a
   lockout or a bot-defense challenge; a 401/403/429 backs off exponentially and is surfaced,
   never retried in a tight loop.
5. **Verified engine.** Every downloaded engine and every executable below `HEADROOM_HOME` is
   canonicalized, ownership/permission checked, and pinned by SHA-256 before execution. There is
   no trust-on-first-use: `headroom engine install --pin` only prints a candidate hash for a human
   to review and commit to the lock file.
6. **No debug surfaces in release.** No debug endpoints, no source maps, no verbose stack traces
   to clients.
7. **Audit log.** Every query to the daemon and every vendor poll is logged with caller, time and
   outcome, without payload secrets.
8. **Dependencies pinned and audited.** Lockfile committed, `npm audit` in CI, minimal dependency
   set.
9. **No telemetry.** Headroom phones home to nothing.
10. **Keychain ACL identity.** On macOS, `headroom-claude-probe` reads the Keychain item and
    performs the Anthropic request itself. It prints only bounded usage JSON; tokens, refresh
    tokens, and email never cross to Node. Run `headroom keychain grant` once interactively and
    choose “Always Allow” for this probe. An updated probe binary is a new ACL identity and asks
    once more. There is no `security` fallback.
11. **Bounded vendor input.** Credential-backed responses are limited to 1 MiB, JSON depth 32,
    arrays of 10,000 items, and strings of 64 KiB.
12. **Outbound allowlist.** Credential-backed requests only target
    `api.anthropic.com`, `chatgpt.com`, the Google OAuth/Code Assist hosts, and
    configured local base URLs. Proxy environment variables are ignored unless a
    `proxy` value is explicitly set in `policy.toml`.
13. **Antigravity source eligibility.** The daemon-kept `agy` session is the primary
    Antigravity source. The remote Google OAuth fallback is only available to accounts
    whose Gemini Code Assist tier is still served; a vendor refusal includes its HTTP
    status and redacted reason code/message, but never the OAuth token or email address.
14. **Lease ownership is cooperative, not authenticated.** A lease's `owner` is a
    client-supplied string, not a credential. Node's `net` module exposes no peer
    credentials API (no `SO_PEERCRED`/`LOCAL_PEERCRED` equivalent) for a Unix domain
    socket connection, so the daemon cannot cryptographically bind a lease to the
    process that started it. Given rule 3's threat model (single-user machine, mode-0600
    socket), the practical guarantee is: only processes running as the same OS user can
    reach the socket at all, and every call already carries the caller's self-reported
    pid and `argv[1]` (see `callerFrom` in `src/daemon.ts`), recorded in the audit row
    beside the lease owner and meter. The MCP stdio server strengthens this further,
    since it serves exactly one client per process: a lease started without an explicit
    `owner` is bound to `<client name>#<session id>`, a session id assigned once per
    `initialize` call, and `force`-ending another owner's lease over MCP requires
    `confirm_force: true` plus a non-empty `reason` string, both audited. None of this
    stops a misbehaving process running as the same user from claiming any owner string
    it likes; it stops accidental cross-orchestrator lease collisions, which is the
    threat that actually occurs in practice.

## Out of scope

Web-app classes (SQL/NoSQL injection, CSRF, XSS, payments, tenant isolation) do not apply to a
local single-user daemon and are not defended against beyond rule 3.

## Reporting

Open a private security advisory on the GitHub repo.
