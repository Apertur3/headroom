# Vendors

What Headroom reads for each vendor, where it reads it from, which meters it emits, and the
limitations that have actually shown up against live accounts. Endpoints and file paths below come
straight from the adapter source (`src/adapters/*.ts`); when something here looks wrong, that
source is the tiebreaker, not this page.

## Building the Swift engine

`engine/Package.swift` pins `CodexBarCore` to `steipete/codexbar` at the same release tag as the
CodexBarCLI assets in `engine.lock.json`. Building the Swift engine (`npm run engine:build`,
`swift build --package-path engine`, `swift test --package-path engine`) therefore fetches that
dependency's source from GitHub over the network; there is no vendored or offline copy. A build run
without network access to GitHub fails at dependency resolution, not at compile time.

## Claude

Headroom reads Claude Code usage two ways: a zero-auth statusline snapshot (preferred whenever
it's fresh) and the vendor probe (the fallback, and the only path for a profile that has never
rendered a statusline).

### Zero-auth source: the statusline snapshot

Claude Code hands its `statusLine` command a JSON object on every prompt render, containing
`rate_limits.five_hour`/`rate_limits.seven_day` (`used_percentage`, `resets_at`, epoch seconds) and
possibly other model-scoped buckets. `headroom statusline`, registered as that command (see
quickstart.md), snapshots it to `<HEADROOM_HOME>/statusline/<profile>.json` (0600; `<profile>` is
the `CLAUDE_CONFIG_DIR` basename, or `default`). The `native:claude-statusline` adapter
(`src/adapters/claude-statusline.ts`) reads that file back: `truth: official`, freshness `fresh`
under 10 minutes old and `stale` beyond that. It also reads an existing collector's own
existing shape (`state/<alias>.json`: top-level `alias`, `five_hour`/`seven_day` with `used_pct`),
matched to a principal by an explicit `alias` field on that account in `accounts.toml`, or by the
convention alias `"main"` means the default profile. Which directories are scanned is
`policy.toml`'s `statusline_snapshot_dirs` (default: just `<HEADROOM_HOME>/statusline`).

Every configured directory is trust-checked before it is ever scanned (safe ancestry, not a
symlink, not foreign-owned or writable by group/other without the sticky bit); one that fails is
skipped with a single line to stderr, never read. Each `.json` file within it is then read
defensively: opened only after an `lstat` rejects a symlink or non-regular file, bounded to 64 KiB
and 64 files per directory, and its JSON structure depth-bounded. A snapshot's `observed_at` is
rejected outright (not merely marked stale) if it falls outside JavaScript's own `Date` range or
more than five minutes in the future, so a bad or future-dated file can never win the
newest-snapshot comparison or crash the reader; a malformed `resets_at` on an otherwise-valid
bucket is dropped to "unknown reset" rather than aborting the snapshot. `headroom statusline`
itself resolves the same safe Headroom home every other command uses before writing, verifies the
`statusline` directory the same way (0700, refusing a symlink or foreign-owned directory), and
writes each snapshot through a uniquely named temporary file renamed into place, refusing outright
rather than following an existing symlink at the destination.

The collector prefers a fresh snapshot over the probe outright -- for a Claude principal set up
this way, Headroom never touches the Keychain at all, and a principal still waiting on
`headroom keychain grant` reads normally anyway. A stale or missing snapshot falls back to the
probe below, unchanged.

### Vendor probe

Headroom reads Claude Code's own OAuth access token and calls
`GET https://api.anthropic.com/api/oauth/usage`.

Credential location: on macOS, the token lives in the Keychain, under service name
`Claude Code-credentials` for the default `~/.claude`, or
`Claude Code-credentials-<8 hex characters>` (a hash of the resolved config directory) for any
other profile. Headroom never reads that token itself there: a signed helper binary,
`headroom-claude-probe`, reads the Keychain item and makes the usage request in the same process,
so the token never reaches Node or Headroom's own output. On Linux and Windows, Headroom reads the
token directly from `<config-dir>/.credentials.json` (default `~/.claude/.credentials.json`).

Meters emitted: `<principal>:all` (the 5-hour and 7-day windows from the response's `five_hour`
and `seven_day` fields), `<principal>:fable`, `<principal>:routines`, and one
`<principal>:<model-slug>` meter for every other model-scoped bucket the response's `limits[]`
array carries (e.g. `<principal>:sonnet-5`). Fable and Routines come from whichever scoped limit
matches by model display name, falling back to the older `seven_day_fable*` / `seven_day_routine*`
/ `seven_day_cowork*` fields if present.

A scoped limit's `is_active: false` flag means "no percent to show" only when there genuinely is no
percent in the response -- that meter reports freshness `not_enforced` (`n/a` in the CLI), same as
before. A scoped limit that carries a percent is never dropped just because the vendor flags it
inactive: Headroom emits it as a real, fresh window (enforcement `soft` rather than `hard`,
`metadata.vendor_active: false`, reason "vendor flags this limit inactive; shown because it carries
a cap"), since a real cap the vendor's own `/usage` dashboard shows near its limit is exactly the
number an orchestrator needs, whatever the vendor calls the bucket. `gate --model fable` (and
`--meter <principal>:fable` directly) answers against this meter; `can` for the `claude-fable`
routing class already consumes it via `routing.toml`.

## Codex

Headroom reads the ChatGPT OAuth access token from Codex's own auth store and calls
`https://chatgpt.com/backend-api/wham/usage` and
`https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`, with the account id pulled from
the stored token if the file itself doesn't carry one. It also reads the 20 most recently modified
session log files (`.jsonl` / `.log`) under `<CODEX_HOME>/sessions` for a `rate_limits` payload the
Codex CLI writes itself, and uses that only to fill in a window the endpoint left `n/a` or failed,
never to override a good endpoint read.

Credential location: `<CODEX_HOME>/auth.json`, default `~/.codex/auth.json`, read directly as a
file on every platform. There is no Keychain path for Codex.

Meters emitted: `<principal>:main` (5-hour and weekly), `<principal>:spark` (5-hour and weekly,
only when the response's `additional_rate_limits` includes a Spark entry), and
`<principal>:credits`, a `count` window with no reset duration; it is informational and never
gates `can`.

Known limitation, verified live: on some plans the endpoint's `primary_window` (the 5-hour window)
is absent from the response, and there's no recent session log to fall back to. Headroom
reports that window `not_enforced` with reason "no 5-hour window from endpoint or session logs",
printed as `n/a`, rather than guessing.

## Antigravity

The remote quota endpoint is the primary source; the daemon-kept local `agy` process is a
fallback, used only when remote can't answer.

The remote path reads Gemini CLI's Google OAuth credentials, refreshing the token first if it's
expired, then follows the same sequence CodexBar's Antigravity provider does against
`cloudcode-pa.googleapis.com`: `v1internal:loadCodeAssist` (metadata `ideType: "ANTIGRAVITY"`) for
the account's current tier and project id; finally `v1internal:retrieveUserQuota` with that project
id. Headroom reads usage, it does not provision Code Assist accounts or pick a billing tier on the
caller's behalf: there is no `onboardUser` call anywhere in this path. If neither the stored
credential nor `loadCodeAssist` names a project, the read comes back `failed` with reason "no Code
Assist project; finish setup in the Gemini CLI" rather than onboarding one. Never persists anything
it learns (project id included) -- every poll re-resolves it, so a failed write can never leave a
stale or wrong value on disk.

Token refresh needs the Gemini CLI's own OAuth client id/secret, which Headroom never hardcodes:
it checks `GEMINI_OAUTH_CLIENT_ID`/`GEMINI_OAUTH_CLIENT_SECRET`, then `GEMINI_OAUTH2_JS_PATH`, then
the installed Gemini CLI package (the `gemini` binary's real path, walked upward for
`oauth2.js`/`bundle/gemini.js` under an npm-global or Homebrew layout). A Homebrew-published
`gemini-cli`'s `bundle/gemini.js` is only a small bootstrap that dynamically imports the real code
from content-hashed sibling files (`bundle/chunk-<hash>.js`), so on that layout none of the fixed
candidate paths ever contain the client -- the last resort is a scan of every `.js` file directly
in the bundle directory. `headroom doctor`'s "Antigravity OAuth client" check reports which layout
actually matched (never the id/secret themselves). Every file this discovery reads -- the fixed
candidates, the environment override, and the chunk scan alike -- must be a regular file (never a
symlink) and is charged against one shared 16 MiB / 200-file budget for the whole attempt; an
oversized or otherwise unsafe bundle is treated as unavailable rather than read.

Only when the daemon owns a warmed `agy` pseudo-terminal (started under `script -q /dev/null agy`
on macOS and Linux only; never on Windows, and never merely because a principal is configured --
see keepalive below) does a poll also ask the native Swift engine for agy's own local quota
summary, used only once remote comes back short of real buckets.

Credential location: the remote path reads `~/.gemini/oauth_creds.json` on every platform, the
same file the Gemini CLI itself writes. There's no Keychain path for Antigravity.

Meters emitted: `<principal>:gemini` and `<principal>:claude-gpt`, each with a 5-hour and a weekly
window, with `used` computed as `(1 - remainingFraction) * 100` from the vendor's quota buckets.
`headroom --principal <name> --shape` prints the key/kind shape of every response the sequence
made (`loadCodeAssist`, `retrieveUserQuota`), plus `loadCodeAssist`'s own tier and any
`ineligibleTiers[].reasonCode` it reported, so a denied tier is visible without guessing at
Google's response shape.

Keepalive is secondary: a poll's remote read is always tried first, and the daemon starts `agy`
lazily -- only the first time a poll shows remote fell short (availability-only, a 403, or a
transport failure) for an Antigravity principal, never unconditionally at daemon startup. A daemon
whose remote reads are always real spawns agy exactly never. Once started it keeps running the
same way it always has; a failed read's `reason` names both outcomes (e.g. "quota endpoint
returned availability only; agy keepalive not running" or "...; agy quota summary not ready").

Known limitations, verified live:

- Google's remote quota endpoint answers 403 for the free Gemini Code Assist tier, or otherwise
  returns a response with no `remainingFraction` on any bucket. Either is availability-only, not
  usage, and Headroom reports every window `failed` with reason "quota endpoint returned
  availability only" rather than showing it as 0% used -- there is no number to show.
- The daemon-kept local `agy` read can report a window that looks the same shape as that
  availability response: zero or unknown usage with a reset that lands within 90 seconds of
  "fetch time plus window length" (`detectPlaceholder` in `src/engine/observation.ts`). Per the
  repository owner's decision, Headroom no longer discards this as a heuristic false positive --
  a genuinely idle rolling window is shaped exactly the same way, and Google's own Antigravity app
  shows the vendor's own 100% in that case. The reading is shown as-is (freshness, quantity and
  reset all vendor-reported), downgraded to `truth: "estimated"` at half confidence with reason
  "vendor reports an idle window; reset equals fetch time plus window length, so this may be a
  placeholder"; `headroom` status appends `(idle, unverified)` to the line. It is only escalated to
  a real `failed` reading when the store's own history contradicts it: a fresh reading for the
  same meter and window, within the last 2 hours, already showed real usage whose reset has not
  happened yet -- a vendor cannot legitimately go idle without a reset in between, so that reading
  is demoted with reason "idle reading contradicts the previous fresh reading (N% used, reset not
  yet due)".
- Windows has no daemon-kept `agy` and no native engine path for it, so an Antigravity principal
  on Windows is remote-only, and inherits the free-tier 403 above without a local fallback.

## Local pools (vLLM, llama.cpp)

Headroom probes an OpenAI-compatible `/v1/models` endpoint for liveness at the account's
`base_url`, plus best-effort `/metrics` (reading vLLM's Prometheus gauges
`vllm:num_requests_running` and `vllm:num_requests_waiting`) and `/health`. There is no
credential: `base_url` and an optional `wake` command live in `accounts.toml`, and Headroom only
ever reports that command, never runs it.

Meters emitted: `<principal>:capacity`, a `state` window rather than a percentage, reported UP,
BUSY, or DOWN with the model ids currently loaded and the running/waiting request counts. Its cost
model is `marginal`, not `sunk`: idle local capacity is not "free" the way idle subscription
capacity is, because it still burns energy to be available.

Known limitation, verified live: a pool that fails `/v1/models` (unreachable, wrong port, box
asleep) is reported DOWN with the configured wake hint if one exists; it is never treated as
UNKNOWN, since "down" is itself a confirmed state, not a missing read.
