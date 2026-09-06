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

## Gemini CLI

The Gemini CLI subscription (Gemini Code Assist quota) is a plain remote read: no daemon, no local
process, no fallback source. It shares its whole transport with Antigravity above --
`src/adapters/google-code-assist.ts` holds the credential read, the in-memory token refresh, the
bundled OAuth client discovery and both Code Assist calls, and the two adapters import it -- so
everything said above about bounded reads, the 16 MiB / 200-file bundle scan budget and never
persisting a resolved project id applies here unchanged.

What differs is the client identity: this path sends `metadata.ideType: "GEMINI_CLI"` (with
`pluginType: "GEMINI"`, and no product `User-Agent`) on `v1internal:loadCodeAssist`, which is what
tells Google whose quota is being asked about, then posts the resolved project id to
`v1internal:retrieveUserQuota`. There is no `onboardUser` call: when neither the stored credential
nor `loadCodeAssist` names a project, the read is `failed` with reason "no Code Assist project;
finish setup in the Gemini CLI".

Credential location: `~/.gemini/oauth_creds.json` on every platform, the file the Gemini CLI itself
writes. The CLI's own `GEMINI_CLI_HOME` overrides the home it looks under, so a principal's
`location` is that `<home>/.gemini` directory. `headroom accounts discover` adds a `gemini`
principal when that credential exists, named `gemini-<home basename>` for a `GEMINI_CLI_HOME`
override so two Gemini logins on one machine stay distinguishable; `doctor` reports the credential
file's presence and permissions like every other file-backed vendor. An Antigravity principal reads
the same file for a different product's quota, so both can exist side by side.

Meters emitted: one per model family the quota buckets carry, `<principal>:<model family>` from the
bucket's own `modelId` (e.g. `gemini:gemini-2.5-pro`), plus `<principal>:all` for a bucket that
names no model. `used` is `(1 - remainingFraction) * 100`; when one family reports several buckets
for the same window (Google splits input and output token types) the lowest remaining fraction
wins, since that is the one that will actually stop the account. A window length is taken only from
a bucket that names its own period (an explicit `windowMinutes`, or wording like weekly/daily/
5-hour/hourly) -- nothing infers a duration from a reset time, so a bucket that names no period
gets a reset with a null window length rather than an invented one.

Known limitations:

- An account tier without quota entitlement gets 403 from `retrieveUserQuota` (the same refusal the
  Antigravity path sees on the free Code Assist tier). That is an answer about the account, not a
  transport error, so it becomes one `failed` reading with reason "quota endpoint not permitted for
  this account tier (403)" -- inside the shared protected-status backoff, so the next poll holds off
  instead of re-asking a settled question. There is no local fallback source to rescue it.
- A 200 response whose buckets carry no `remainingFraction` is availability, not usage: reported as
  `failed` with reason "quota endpoint returned availability only" rather than as 0% used.
- A failed read carries a single `<principal>:all` row. Model families are only known from a
  response that answered, so a read that got none reports no per-family meters rather than
  inventing ones this account may not have.

## Grok

Headroom reads the token `grok login` writes and calls the Grok CLI's own chat proxy:
`https://cli-chat-proxy.grok.com/v1/billing?format=credits` for usage, and
`https://cli-chat-proxy.grok.com/v1/settings` for the plan name. Both requests send
`Authorization: Bearer <token>`, `x-xai-token-auth: xai-grok-cli` and `Accept: application/json`.
The settings call is optional enrichment on a 2-second budget: a failure, a timeout, or a 200 that
omits `subscription_tier_display` drops the plan label and leaves the usage reading untouched.

Credential location: `<GROK_HOME>/auth.json`, default `~/.grok/auth.json`. That file is a map keyed
by scope URL; Headroom prefers the `https://auth.x.ai::<client-id>` (OIDC) entry and falls back to
the legacy `https://accounts.x.ai/sign-in` one, taking the entry's `key` as the bearer token and its
`expires_at` as the expiry. An entry carrying no usable key is skipped, so a stale record cannot
shadow a healthy one. An `accounts.toml` `location` may name the file itself or the directory
holding it. The file must be a regular file, never a symlink, owned by the user running Headroom,
and it is read under the same 64 KiB bound as every other external file Headroom did not write.
The token lives in memory for the length of the request only: it is never logged, never written
anywhere, and every failure reason is passed through the shared redactor before it is stored.

Meters emitted:

- `<principal>:main`, the subscription allowance as a percent, read from `config.creditUsagePercent`
  and falling back to `config.onDemandUsed.val / config.onDemandCap.val`. The window length comes
  from the published billing period (`config.currentPeriod.start` and `end`, or its
  `USAGE_PERIOD_TYPE_DAILY` / `USAGE_PERIOD_TYPE_WEEKLY` type), never from the time left until
  reset, so a monthly period read near its end is not misreported as a weekly one. The reset is
  `config.currentPeriod.end`, then `config.billingPeriodEnd`.
- `<principal>:credits`, the on-demand balance the same payload reports as an amount rather than a
  window: a `count` window with unit `credits`, informational, and it never gates `can`. Same shape
  as the Codex reset credits above.

Neither endpoint publishes a per-model bucket today, so no `<principal>:<slug>` meter is emitted.

Failure reasons:

- 401: "Grok rejected the token; run: grok login", with a `GROK_HOME=` prefix for a non-default
  location.
- 403: the same wording with the status kept in it, and 429: "Grok usage request failed (429)".
  Both carry the parenthesized status the collector's protected-status backoff matches on, so a
  principal the vendor is actively refusing is not polled again immediately.
- Expired token: "token expired; run: grok login". Missing or unsafe file: "no credentials for this
  config dir; run: grok login".
- A billing period the vendor answers with no usage figure at all: the `main` meter is `failed`
  with reason "vendor returned no usage percentage". That is an answered request with nothing to
  report, not a reading of zero, and the vendor's own client shows no bar for it either.

Not supported, deliberately: the browser-cookie path. CodexBar can import grok.com session cookies
from Chrome as a further billing fallback. Reading another application's cookie store is outside
this project's threat model -- it means handling credentials Headroom was never given, for a host
it does not otherwise talk to -- so only the bearer-token path is implemented. Without `grok login`
there is no Grok reading.

## Kimi

Kimi is Moonshot's subscription (the Kimi app and the Kimi Code CLI). Headroom calls the same
Connect-style gateway the Kimi Code console itself uses, at `https://www.kimi.com/apiv2`:

- `kimi.gateway.billing.v1.BillingService/GetUsages`, body `{"scope": ["FEATURE_CODING"]}`. This is
  the required call and the only one whose failure fails the read.
- `kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats`, body `{}`, for the shared
  subscription pool and the membership 7-day Code ratio.
- `kimi.gateway.membership.v2.MembershipService/GetSubscription`, body `{}`, for the plan title.

The last two are best effort: a failure there costs the plan name or the pool meter, never the
allowance read.

Credential location: **a file you write yourself**, named by `location` in `accounts.toml`
(default `~/.kimi/auth.token`). It must be a regular file you own, mode 0600, containing only the
token and nothing else. There is no automatic credential path here on purpose: the Kimi desktop app
keeps its session token in its own Chromium cookie database (`~/Library/Application
Support/kimi-desktop/Cookies`), and reading another application's cookie store is outside this
project's threat model, so Headroom never opens it. To fill the file: sign in at
`https://www.kimi.com/code/console`, copy the `kimi-auth` token from your own session, write it to
that path and `chmod 600` it. The token is held in memory for the length of one poll and is never
logged, stored, or written anywhere; every failure reason is redacted before it is recorded.
`headroom accounts discover` adds a `kimi` principal when that file exists, and `headroom doctor`
reports whether it is present and still 0600. The adapter refuses a symlink, a file owned by
someone else, a file readable by group or other, anything over 8 KiB, and any content that is not
one bare token.

Meters emitted: `<principal>:main` carries the FEATURE_CODING allowance window plus every
rate-limit window the same response declares (the 5-hour bucket on current plans), the way Codex's
`main` carries both its 5-hour and weekly windows; `<principal>:total` is the shared subscription
pool (`amountUsedRatio`), which spans every feature and not just Code; `<principal>:code-7d` is the
membership 7-day Code ratio, emitted only when it genuinely diverges from the allowance (within 1
percentage point and 5 minutes of the same reset, it is the same quota read twice and the duplicate
is dropped); `<principal>:credits` is optional, see below. Window kind, window length and reset all
come from the response. The one exception is the allowance bucket, which the gateway reports
without a window of its own: it is labelled with the vendor's documented 7-day period.

Optional second location, the Moonshot platform balance: if a file named `moonshot.key` sits beside
the token file (same directory, same 0600 rules) holding a Moonshot API key, Headroom also calls
`GET https://api.moonshot.ai/v1/users/me/balance` and emits `<principal>:credits`, a `count` window
with no reset. It is informational, never a gate, and its failure never touches the subscription
meters. Its absence is simply "not configured": no meter, no failure row. Only the international
host is called; there is no `api.moonshot.cn` path.

Both hosts (`www.kimi.com`, `api.moonshot.ai`) are on the outbound allowlist and nothing else in
this adapter may leave the machine; redirects are refused rather than followed, and responses are
size- and depth-bounded like every other vendor read.

Known limitations:

- A 401 fails the read with "Kimi rejected the token (401); sign in at
  https://www.kimi.com/code/console and refresh `<path>`" -- the token is a web session token, so it
  expires on the vendor's own schedule and is replaced by hand. A JWT whose own `exp` has already
  passed fails the same way without spending a request. 403 and 429 go through the collector's
  protected-status backoff like any other vendor.
- A rate-limit bucket whose window unit the gateway spells in a way this adapter does not recognize
  is skipped rather than given a guessed duration.
- A bucket with no usable `used` and no valid `remaining` is reported `failed`, not 0% used. There
  is no number to show.

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
