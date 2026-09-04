# Vendors

What Headroom reads for each vendor, where it reads it from, which meters it emits, and the
limitations that have actually shown up against live accounts. Endpoints and file paths below come
straight from the adapter source (`src/adapters/*.ts`); when something here looks wrong, that
source is the tiebreaker, not this page.

## Claude

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
and `seven_day` fields), `<principal>:fable`, and `<principal>:routines`. The last two come from
whichever "scoped limit" in the response's `limits[]` array matches Fable or Routines by model
display name, falling back to the older `seven_day_fable*` / `seven_day_routine*` /
`seven_day_cowork*` fields if present.

Known limitation, verified live: when the vendor marks a scoped limit inactive
(`is_active: false`), Headroom reports that meter with freshness `not_enforced`, which the CLI
prints as `n/a` rather than a stale or zero percentage. A Fable-scoped weekly meter that the
vendor has turned off for an account shows `n/a`, not `0%`.

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

Headroom reads Antigravity through two separate paths, not one.

While the daemon owns a warmed `agy` pseudo-terminal (started under `script -q /dev/null agy` on
macOS and Linux only; the daemon never keeps this warm on Windows), it asks the native Swift
engine to read agy's own local quota summary. A one-shot CLI or MCP call made without a running
daemon never touches this local path; it always goes straight to the remote path instead. The
remote path reads Gemini CLI's Google OAuth credentials and POSTs to Google's
`v1internal:retrieveUserQuota` on `cloudcode-pa.googleapis.com`, refreshing the token first if it's
expired.

Credential location: the remote path reads `~/.gemini/oauth_creds.json` on every platform, the
same file the Gemini CLI itself writes. There's no Keychain path for Antigravity.

Meters emitted: `<principal>:gemini` and `<principal>:claude-gpt`, each with a 5-hour and a weekly
window, with `used` computed as `(1 - remainingFraction) * 100` from the vendor's quota buckets.

Known limitations, verified live:

- Google's remote quota endpoint is deprecated for the free Gemini Code Assist tier. A response
  with no `remainingFraction` on any bucket is availability-only, not usage, and Headroom reports
  every window `failed` with reason "quota endpoint returned availability only" rather than
  showing it as 0% used.
- The daemon-kept local `agy` read can produce the same kind of placeholder. Headroom compares
  each window's reset time to its fetch time and its own duration; if two or more windows show
  zero or unknown usage with a reset that lands within 90 seconds of "fetch time plus window
  length," it treats the whole snapshot as manufactured and marks it `failed`, the same as the
  remote placeholder. Headroom refuses to show either kind of placeholder as real capacity.
- Windows has no daemon-kept `agy` and no native engine path for it, so an Antigravity principal
  on Windows is remote-only, and inherits the free-tier deprecation above without a local
  fallback.

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
