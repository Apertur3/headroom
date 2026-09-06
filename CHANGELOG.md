# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-beta.4] - 2026-09-06

### Fixed
- A fresh statusline snapshot no longer skips a granted Claude probe, so the model-scoped meters (Fable, Routines) update every poll; the snapshot is the fallback for the account-wide windows when the probe is blocked or fails.
- Windows named pipe: the daemon only ever authenticated the client, not itself. Because the pipe
  namespace is machine-global, another local process (including one running as a different user)
  could squat the pipe name before the real daemon started and answer requests with forged results;
  `health`'s static signature made this worse since it could be captured once from a real daemon and
  replayed forever. The client now verifies a per-connection proof on every reply, including
  `health`'s, and treats a missing or wrong one exactly like no daemon answering at all. POSIX is
  unaffected.
- Claude statusline snapshots: every configured snapshot directory and file is now trust-checked
  before being read -- safe ancestry, no symlinks, not foreign-owned or writable by group/other --
  with an unsafe directory skipped (one line to stderr) rather than read, and each file bounded to
  64 KiB, 64 files per directory, and a shallow JSON depth. A snapshot timestamp outside
  JavaScript's `Date` range or more than five minutes in the future is now rejected outright instead
  of winning newest-snapshot selection forever or crashing the reader, and a malformed reset no
  longer aborts an otherwise-valid snapshot. `headroom statusline` now resolves and verifies the
  same safe Headroom home and statusline directory every other command uses before writing, and
  writes each snapshot through a temporary file renamed into place, refusing to write through an
  existing symlink at the destination rather than following it.
- Windows named pipe, second pass: the mutual-auth proof above only ever covered the two nonces, so
  a live process relaying a genuine handshake to the real daemon could still ask it for an
  unauthenticated answer to some request and hand a different result back to the waiting client
  with that same, still-valid proof attached. The proof now also binds the exact request and reply
  bytes exchanged on the connection (SHA-256 hashes of both, sent as their own line right after the
  reply), so substituting either one fails verification. Separately, the daemon and a client could
  select two different pipe names for the same Headroom home when it was spelled differently
  (trailing separator, letter case, `.`/`..` components); both now canonicalize through one
  function first. The connection cap could also be held open indefinitely by a connection that
  never completed the handshake, or made to buffer unbounded work from one connection sending many
  requests without waiting for a reply; a pipe connection is now closed if it does not authenticate
  within 5 seconds, closed after 30 seconds of inactivity, limited to one request in flight at a
  time, and never left to buffer unlimited unwritten output. The client-side pipe reader is now
  bounded too: a nonce frame must be exactly 32 lowercase hex characters, a response over 256 KiB
  is treated as unresponsive, and every request has a 10-second absolute deadline in addition to
  its existing inactivity timeout. POSIX is unaffected throughout.
- `rate`, `plan`, `gate` and `fill` now apply the same staleness/age gate `can` and `route` already
  did before scoring a pace state: a window that is stale, failed, or older than
  `staleness_minutes` answers UNKNOWN by name instead of computing a plan line, a gate decision, or
  a lane count off a reading that might no longer be true. `gate` with `--class`/`--meter`
  resolving to several meters also no longer silently skips a meter that has never produced a
  windowed reading at all while a different, populated meter in the same class answers YES on its
  own -- that now fails the whole gate UNKNOWN, naming the unread meter.
- All thirteen MCP tools now validate their arguments against the tool's own declared schema
  before any dispatch, to the daemon or to the direct fallback: a wrong type, a number outside the
  same bounds the CLI enforces (`reserve_percent`/`expected_percent` 0-100, `plan_share_percent`
  >= 0, `lane_cost_percent`/`ttl_ms`/`minutes` > 0), or an argument name the tool never declared is
  now refused as a JSON-RPC invalid-params error naming the argument, instead of being coerced,
  silently dropped, or ignored. `quota_gate`'s `needs` array is rejected as a whole the moment one
  entry is not a valid `"5h:N"`/`"wk:N"` string, rather than quietly gating on only the valid
  entries. `quota_lease_start`'s direct (no-daemon) fallback also now preserves a supplied
  `action_class`, which it previously dropped.
- `headroom route` (and `quota_route`) now reserves every OTHER owner's active lease against the
  same meters before scoring and ranking a candidate, the same reservation `can`/`quota_can`
  already applied -- it no longer recommends a principal whose remaining capacity a different
  orchestrator has already reserved.
- Learned costs (`headroom cost`, `can`'s expected-cost report, `fill`'s fallback lane cost) now
  train only on leases that have ended or expired; an in-progress lease is no longer counted as a
  zero-cost sample. A batch of just-started jobs can no longer drag the median toward zero and
  inflate the sample count before any of them are actually done. A completed lease with genuinely
  no spend still counts as one real zero-cost sample.
- `headroom setup --dry-run`, and the implicit non-TTY plan, described the doctor and final-check
  steps instead of running them: neither ever opens the Headroom home database, performs a
  Keychain lookup, or polls a vendor while planning, and an empty temporary home now stays empty
  through the whole plan. An empty answer to any setup prompt is now treated as No, matching the
  displayed `[y/N]`, instead of as Yes.
- Antigravity: a remote usage read or `--shape` with no resolvable Code Assist project no longer
  provisions one. The `onboardUser` call, which silently POSTed a selected billing tier under
  credentials supplied only for reading usage and could swallow a protected vendor status (401,
  403, 429) in the process, is removed entirely; a missing project now comes back as a normal
  failed reading with reason "no Code Assist project; finish setup in the Gemini CLI".
- The release workflow's manual re-publish no longer interpolates the dispatched tag directly into
  a shell script; it is passed through an environment variable, checked against the release-tag
  grammar before use, and the downloaded release asset's own `package.json` version must match the
  tag or the workflow refuses to publish.
- Gemini OAuth client discovery and the Antigravity keepalive's log reader now require a regular
  file (never a symlink) everywhere they read one, including the environment-override and
  PATH-derived candidates; discovery is bounded to 16 MiB and 200 files per attempt, and the
  keepalive reads only the last 64 KiB of the newest log rather than the whole (possibly still
  growing) file. An oversized or otherwise unsafe candidate is treated as unavailable, and two log
  samples from the same supervisor can no longer overlap.
- `scripts/privacy-sweep.sh --check` no longer reports a clean pass for a missing or unreadable
  input, and neither privacy script can silently read a grep failure, an invalid denylist regular
  expression, or an unreadable file as "no hits" -- each is now a hard scan error that fails the
  run on its own. `public-audit.sh` now reads tracked filenames NUL-delimited throughout, so a
  filename with a space or a quote can no longer be split or dropped. The CGNAT check in
  `privacy-sweep.sh` now covers the RFC 6598 second-octet range (64 through 127) instead of only
  the /16 whose second octet is literally 64.
- `scripts/build-probe.sh` no longer writes an unencrypted private key to a fixed-password PKCS#12
  file: the key is generated in a mode-0700 temporary directory, exported and imported under a
  random password generated fresh for that one run and held only in memory, imported for
  `codesign` alone (never every application), and the private key and PKCS#12 bundle are shredded
  immediately after import -- including under `HEADROOM_BUILD_PROBE_KEEP_WORKDIR`, which now keeps
  only the certificate and openssl config it exists to let a test inspect.

## [0.1.0-beta.3] - 2026-09-06

### Added
- `headroom setup`: a one-shot interactive setup for a person without an agent. Walks through
  account discovery, `doctor`, the macOS Keychain grant, the background service install and the
  MCP registration, printing each step before it runs and asking a yes/no question before
  anything that changes something. `--dry-run` shows the full plan without changing anything;
  `--yes` answers yes to every step except the Keychain grant, which it never runs on its own --
  it prints the command to run by hand instead; `--skip-service` and `--skip-mcp` leave those
  steps out. With no TTY on stdin and no `--yes`, it prints the plan and exits 0 instead of
  blocking on a question a script cannot answer. Replaces sections 2-7 of the quickstart for
  anyone who would rather run one command than read the walkthrough.

### Changed
- Antigravity: a daemon-kept `agy` local quota summary reporting an idle window (0% or unknown
  usage, reset equal to fetch time plus window length) is now shown with its vendor-reported
  numbers and a doubt marker (`truth: "estimated"`, halved confidence, `(idle, unverified)` in
  `headroom` status) instead of being replaced with UNKNOWN on a heuristic. It is only demoted to a
  real failure when the store's own history contradicts it -- a fresh reading for the same meter
  and window within the last 2 hours already showed real usage whose reset has not yet passed. An
  availability-only payload (no vendor bucket carries a `remainingFraction` at all) is unchanged:
  still reported UNKNOWN, since there is no number to show.

## [0.1.0-beta.2] - 2026-09-05

### Added
- `headroom statusline`: a zero-auth Claude source. Register it as Claude Code's own `statusLine`
  command and Headroom reads the same JSON Claude Code already renders every prompt instead of
  ever touching the Keychain, with `--chain` to keep an existing statusLine command's own output.
  Also reads an existing collector's `state/<alias>.json` shape, configurable via
  `policy.toml`'s `statusline_snapshot_dirs`.
- `headroom route --class <action-class> --owner X`: picks the principal with the most remaining
  headroom in the tightest window among the routing entry's allowed principals of one vendor, and
  prints its launch environment (e.g. `CLAUDE_CONFIG_DIR=~/.claude2`); exit 2 when none fits.
- `headroom --principal <id> --models`: a best-effort local estimate of per-model token share over
  the current 5h window, read from Claude Code's own session logs.
- `headroom --refresh` (and `--ttl 0`): forces a fresh poll through the daemon, respecting the
  grant marker and the daemon's own vendor backoff.
- `headroom version` / `headroom --version`.
- A scoped Claude meter (Fable, Routines, or any other model-scoped bucket the vendor's response
  carries) that has a percent is never dropped just because the vendor flags it inactive; it is now
  reported as a real, soft-enforced window instead of `n/a`. Every other model-scoped bucket gets
  its own `<principal>:<model-slug>` meter. `gate --model <slug>` answers against it.
- `doctor` prints the Headroom version and which configured Claude profiles have the MCP server
  registered.
- `scripts/build-probe.sh` signs the Claude probe with a stable local identity ("Headroom Local",
  created once in the login keychain) instead of ad-hoc, so a `headroom keychain grant` survives
  every later probe rebuild -- previously every `npm pack`, `release:check`, or global reinstall
  produced a brand-new, unrecognized signing identity and re-triggered the Keychain dialog. Only
  rebuilds the probe when its own source has actually changed. Headroom pins the exact probe binary
  a grant succeeded under (recorded per Headroom home) and always uses that one; `doctor` reports
  when a second, unused candidate binary exists instead of silently switching to it.

- Antigravity reads Google's own quota endpoint first (token refresh, `loadCodeAssist`, onboarding
  when the account has no project yet, `retrieveUserQuota`) with the Gemini CLI's stored OAuth
  credentials, finds the OAuth client in a Homebrew-installed `gemini-cli` too, and starts the
  local `agy` keepalive only when the remote path falls short. `--principal <name> --shape` shows
  the response shapes, the account tier and a denial reason, so a free-tier 403 is diagnosable.
- `scripts/public-audit.sh` runs in CI: tracked archives, commit identities, personal-data
  patterns, process residue and an optional untracked denylist across files and history.

### Fixed
- The local signing identity could not be imported on current macOS (PKCS12 MAC verification
  failure) and an imported one was never recognized because the check filtered on a trust chain a
  self-signed certificate never has; both fixed, so the identity is created once and reused.
- `keychain grant` and `doctor` distinguish a Keychain dialog that cannot be shown from this shell
  (macOS `errSecInteractionNotAllowed` / a cancelled interaction) from a config directory with no
  Claude Code login at all -- the former no longer misreports as "no login".
- `can`'s printed reason for an UNKNOWN meter no longer nests the window state twice.
- A vendor 429 backoff now reports "rate limited by the vendor (429); backing off until HH:MM" with
  the real deadline instead of repeating the original failure indefinitely.
- Windows CI: the launcher's signal-forwarding and the doctor home-directory checks no longer
  assume POSIX file modes or symlink privileges are available.

### Changed
- The release workflow publishes with `npm publish --tag latest` while no stable (non-prerelease)
  version has ever shipped, since npm refuses an implicit `latest` tag for a prerelease version;
  publishes with `--provenance` over OIDC (no `NPM_TOKEN`) when the repository is public and no
  token is configured, keeping the token path as a fallback.

## [0.1.0-beta.1] - 2026-09-05

### Added
- Native adapters for Claude and Codex that read credentials at call time and never refresh tokens.
- Optional Swift engine on CodexBarCore for Antigravity and additional providers.
- Local inference pools (vLLM, llama.cpp) reported as capacity with UP, BUSY and DOWN states.
- SQLite history, reset and free-reset events, pace states with a post-reset grace period.
- `headroom can` go/no-go across every meter an action consumes; `--threshold` exit codes.
- Daemon on a Unix socket, stdio MCP server, launchd and systemd service installer.
- Rejection of availability-only vendor payloads that other tools render as full meters.
