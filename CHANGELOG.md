# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
