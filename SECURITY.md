# Security and threat model

Headroom reads private usage endpoints with the user's own credentials and runs a local daemon.
The threat model is a single-user machine; the assets are the user's OAuth tokens and session
cookies, which unlock paid subscriptions.

## Rules the code must satisfy

1. **No secret on disk in plaintext, ever.** Credentials are read at call time from each account's
   own store (macOS Keychain, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`) and dropped
   after the request. Headroom has no credential store of its own and never mirrors tokens into
   config files (CodexBar's `tokenAccounts` path is deliberately not used).
2. **No secret in output.** Logs, crash dumps, JSON output and history redact tokens (including an
   opaque bearer token with no recognizable prefix, not only `sk-`/`eyJ`/`ya29.`/`GOCSPX-` ones),
   cookies (`Cookie`/`Set-Cookie` headers), Authorization headers and, by default, email addresses.
   `headroom-claude-probe` additionally rejects any string value that is merely shaped like a
   token or key -- a known prefix, a JWT, or a long base64/hex run -- under any JSON key, not only
   ones named `token`/`refresh`/`email`. Observation reasons and metadata are redacted again before
   they are persisted, so a leaked fragment cannot survive a round trip through the database either.
3. **Local-only surface.** The daemon listens on a mode-0600 Unix socket on macOS and Linux. On
   Windows Node cannot supply an explicit pipe DACL through its public API, and the pipe namespace
   is machine-global, so any local process (including one running as a different user, with no
   access to the real session token) can create the same pipe name before the real daemon starts
   and try to answer in its place. Windows authentication is therefore mutual, not one-sided: a
   random per-daemon session token is stored mode 0600 under `HEADROOM_HOME`, and it never crosses
   the pipe in either direction. On every connection the daemon sends a fresh random server nonce
   first; the client answers with its own freshly generated client nonce plus, for every method but
   `health`, an HMAC-SHA256 proof of the server nonce keyed by the token it read locally. A client
   that cannot produce the correct proof is refused before any other request is processed. In the
   other direction, every reply the daemon sends -- including `health`'s, which needs no client
   proof to request -- carries its own HMAC-SHA256 proof keyed by the same token, over both the
   server's nonce and the client's nonce together; the client verifies it before trusting anything
   in the reply, and treats a missing or wrong proof exactly like no daemon answering at all. Binding
   both nonces means a captured reply from one connection can never be replayed on another: `health`
   no longer returns a static, replayable signature, so an impostor that once obtained a real
   `health` reply learns nothing it can reuse. Headroom has no TCP listener.
4. **Polite polling.** Vendor polls are rate-limited and jittered so Headroom never triggers a
   lockout or a bot-defense challenge; a 401/403/429 backs off exponentially and is surfaced, never
   retried in a tight loop. Backoff detection recognizes both the parenthesized status format
   Claude/Codex's adapters produce and Google's own bare `HTTP 429` wording, and the Claude
   Keychain probe carries the same distinction (`HEADROOM_PROBE_FORBIDDEN`/`_RATE_LIMITED`) so a
   probe-side refusal backs off exactly like a direct fetch's would. A direct (no-daemon) MCP
   status read shares one persisted backoff and minimum poll interval with every other reader of
   the same `HEADROOM_HOME`, rather than polling the vendor fresh on every tool call.
5. **Verified engine.** Every downloaded engine and every executable below `HEADROOM_HOME` is
   canonicalized, ownership/permission checked, and pinned by SHA-256 before execution -- on every
   run, not only at install time: the cached engine's ancestry, ownership, and mode are re-checked
   and its binary is re-hashed on every call, so a cache marker recording an old hash is never
   enough to trust a binary another local process could have swapped since. There is no
   trust-on-first-use: `headroom engine install --pin` only prints a candidate hash for a human to
   review and commit to the lock file. A native-engine asset lock entry marked `status: "unpinned"`
   is refused even if a (necessarily crafted) local marker file's `sha256` field happens to match
   its `null` placeholder.
6. **No debug surfaces in release.** No debug endpoints, no source maps (disabled in the build,
   `sourceMap`/`declarationMap` both false), no verbose stack traces to clients.
7. **Audit log.** Every query to the daemon, every scheduled vendor poll (Claude's own probe
   outcome and every other principal's), and every vendor poll from the MCP direct fallback is
   logged with caller, time and outcome, without payload secrets. A request the daemon rejects
   before doing any work -- an unauthenticated pipe client, an unknown action class, an unknown
   routing meter, a missing required parameter -- is audited as `rejected` before the error is
   returned, not silently dropped.
8. **Dependencies pinned and audited.** Lockfile committed, `npm audit` in CI, minimal dependency
   set.
9. **No telemetry.** Headroom phones home to nothing.
10. **Keychain ACL identity.** On macOS, `headroom-claude-probe` reads the Keychain item and
    performs the Anthropic request itself. It prints only bounded usage JSON; tokens, refresh
    tokens, and email never cross to Node. Run `headroom keychain grant` once interactively and
    choose "Always Allow" for this probe. An updated probe binary is a new ACL identity and asks
    once more. There is no `security` fallback.
11. **Bounded vendor input.** Credential-backed responses are limited to 1 MiB, JSON depth 32,
    arrays of 10,000 items, and strings of 64 KiB. The byte cap is enforced while streaming, not
    after buffering a complete body: TypeScript's `vendorText`/`vendorJson` read and count decoded
    bytes chunk by chunk and cancel the stream the instant the cap is crossed, and the Claude
    Keychain probe drives its request through a `URLSessionDataDelegate` that does the same,
    cancelling the task mid-response rather than accumulating a full oversized reply first.
12. **Outbound allowlist.** Credential-backed requests only target `api.anthropic.com`,
    `chatgpt.com`, the Google OAuth/Code Assist hosts, and configured local base URLs. Proxy
    environment variables are ignored unless a `proxy` value is explicitly set in `policy.toml`:
    the `headroom` launcher (`bin/headroom.js`) strips them from the child process's environment
    *before* spawning Node, because Node decides whether to install an env-driven proxy dispatcher
    from the process's *initial* environment, before any application code runs -- stripping them
    afterward, in-process, is too late to undo that decision and is kept only as defense in depth.
    The optional CodexBar engine (`adapter: "codexbar"`) is the one exception to this allowlist:
    it links CodexBarCore, an unmodified pinned third-party dependency that performs its own
    authenticated HTTP request to a host read from the account's own `config.toml`
    (`chatgpt_base_url`), a request Headroom has no interception point to constrain or verify. Every
    reading this adapter produces is therefore marked `truth: "estimated"` regardless of what the
    vendor payload itself claims, and `headroom doctor` prints a one-line notice on any principal
    using it. Prefer the `native-ts` adapter, which stays inside this allowlist end to end;
    `codexbar` exists for providers that adapter does not yet cover.
13. **Antigravity source eligibility.** The daemon-kept `agy` session is the primary Antigravity
    source. The remote Google OAuth fallback is only available to accounts whose Gemini Code
    Assist tier is still served; a vendor refusal includes its HTTP status and redacted reason
    code/message, but never the OAuth token or email address.
14. **Fail closed.** A meter with no observation at all -- a fresh install, a misspelled routing
    entry, an adapter that never ran -- is `UNKNOWN`, never treated as unenforced; `can` returns
    `NO` with a reason naming the meter, never silently authorizes. A routing action class whose
    `[consumes]` entry names a meter with no matching configured principal is a configuration
    error (daemon: JSON-RPC error; CLI: exit 1), as is invoking `can` with no `routing.toml` at
    all. A failed reading for one window (e.g. the 5-hour cap) is never hidden by a healthy
    reading of a *different* window of the same meter (e.g. the weekly cap); supersession in the
    current-status view only ever replaces a reading with a newer one of the *same* window, except
    for a windowless transport/auth failure, which represents the whole meter and is superseded by
    whatever window recovers next. That same recovery closes a windowless outage independently of
    window matching, so a second, later outage after a real recovery gets its own event instead of
    silently extending the first one's.
15. **Lease ownership is cooperative, not authenticated.** A lease's `owner` is a
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

## What we do not protect against

- **Same-user code.** Any process running as the same OS user can read Headroom's database, call
  its socket or MCP server, and see the same bounded, secret-free output a legitimate caller would.
  Headroom defends the boundary between OS users and, on Windows, between processes that can and
  cannot prove they hold the local session token -- not between two programs the operator chose to
  run as themselves.
- **Cooperative lease ownership.** See rule 15: a lease owner string is not a credential, and
  nothing stops a same-user process from claiming any owner name. Leases exist to prevent
  accidental collisions between orchestrators, not to authenticate which one is which.
- **The CodexBar engine's own network calls.** See rule 12: `adapter: "codexbar"` performs a
  request Headroom does not control the destination of. Headroom's response is to mark its output
  as estimated and warn in `doctor`, not to claim it enforces the allowlist there too. Use
  `native-ts` where available if this matters to you.
- **A compromised or malicious build dependency.** `npm audit` and lockfile pinning reduce, but do
  not eliminate, supply-chain risk in `node_modules` or in CodexBarCore's own dependency tree.
- **The operating system's own credential stores.** Headroom trusts the macOS Keychain's ACL
  prompt and the permission bits on `~/.codex/auth.json`/`~/.gemini/oauth_creds.json` to be honest;
  it does not defend against a compromised OS or a modified Keychain daemon.

## Out of scope

Web-app classes (SQL/NoSQL injection, CSRF, XSS, payments, tenant isolation) do not apply to a
local single-user daemon and are not defended against beyond rule 3.

## Reporting

Open a private security advisory on the GitHub repo.
