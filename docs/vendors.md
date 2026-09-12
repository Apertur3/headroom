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
this way, Headroom never touches the Keychain at all, so even a principal whose credential the
probe cannot read reads normally. A stale or missing snapshot falls back to the probe below,
unchanged.

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

**The probe reads through `/usr/bin/security`, and there is nothing to grant.** Claude Code
2.1.263 rewrites its Keychain items with an access list that admits Apple-signed tools and not
third-party applications. Measured on macOS 26.5 with that version: `SecItemCopyMatching` with
`kSecReturnData` from the probe is refused (`errSecAuthFailed`, and `errSecItemNotFound` on other
machines) even from the user's own Terminal, with no dialog offered at all, while `security
find-generic-password -s "Claude Code-credentials" -a <user> -w` returns the token with exit 0 and
no dialog, even from a sandboxed shell. So the probe now runs that tool -- absolute path, argument
vector, never a shell, stdout captured in memory, stderr discarded, 10-second timeout -- and keeps
the framework call only as a silent first attempt that fails immediately rather than blocking.

This replaces the whole Keychain grant design: the one-dialog "Always Allow" step, the marker that
gated a principal after a denial, the rebuild detection that asked for a fresh grant whenever the
probe's signing identity changed, and the "grant lapsed" report for an access list Claude Code had
reset on token refresh. None of it applies to a read the item already admits, and all of it cost
the operator a ceremony that no longer does anything. `headroom keychain grant` is kept as a check:
it runs the probe once per principal and reports `credential readable, no dialog needed` or the
real error. `headroom setup` has no Keychain step, and `headroom doctor` reports the credential as
readable through the Apple security tool, with the item's modification time.

The probe's recorded SHA-256 is still verified on every use, and `scripts/build-probe.sh` still
signs each build with a stable local identity -- but only for build hygiene now, since no access
list is keyed on it.

A `security` run that fails is reported by its exit status alone, never its output (the only thing
on that stream is the secret): an absent item keeps the existing "no credentials in Keychain for
this config dir" wording and the login fix, and anything else reads "the macOS security tool could
not read the credential (exit \<n\>)".

A Keychain item that exists but carries no OAuth access token (Claude Code logged out locally) is
reported separately -- "Claude Code is logged out\[ for \<dir\>\]; run:
\[CLAUDE_CONFIG_DIR=\<dir\>\] claude and sign in" -- since signing back in is the fix.

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

Use Codex reset credits only while the account is on a paid plan. A free-plan credit spend is
reported as an urgent warning because it can discard a saved paid-plan reset.

Known limitation, verified live: on some plans the endpoint's `primary_window` (the 5-hour window)
is absent from the response, and there's no recent session log to fall back to. Headroom
reports that window `not_enforced` with reason "no 5-hour window from endpoint or session logs",
printed as `n/a`, rather than guessing.

## Antigravity

Headroom reads the local quota summary of a logged-in Antigravity CLI (`agy`).
It does not need Gemini CLI, read its OAuth credentials, or call the retired
consumer Code Assist path. The daemon owns a hidden agy process on macOS/Linux;
agy owns authentication and token refresh.

The npm and Homebrew packages include the reader for macOS 14 or later, on both Apple
silicon and Intel. Headroom verifies its bundled SHA-256 record before every use. No Swift
toolchain or separate engine download is needed. Linux and Windows packages do not supply
an Antigravity reader.

Setup on macOS:

1. Install [Antigravity CLI](https://antigravity.google/docs/cli/) and run `agy` to sign in.
2. Install or update Headroom, then run `headroom setup` on a new installation. This discovers
   accounts and installs the daemon. For an existing installation, preserve your account file
   and add the entry below if it is missing.
3. If no service is installed, run `headroom install-service`, then the load command it prints.
   Homebrew service users can run `brew services start headroom` instead.
4. Check `headroom doctor` and `headroom --principal antigravity --refresh --json`.
   The daemon warms agy at startup. An initial reading can remain UNKNOWN until its quota
   summary is ready; subsequent scheduled polls retry it.

```toml
[[accounts]]
name = "antigravity"
vendor = "antigravity"
location = "agy"
adapter = "native-ts"
```

Keep `antigravity_keepalive = true` in policy.toml (the macOS default). Discovery finds
agy on PATH or its installation directory. An optional `agy_path` in the account entry
selects an explicit executable when the service cannot find it. Rerunning discovery replaces
the account file, including manually configured entries.

`headroom engine install` reports the packaged reader as already available. If doctor reports
an integrity failure, reinstall Headroom; it never bypasses a damaged reader by selecting an
unverified development build. Source checkouts can still use `npm run engine:build` when no
packaged reader exists.

Meters are `<principal>:gemini` and `<principal>:claude-gpt`, each with five-hour and
weekly windows. Missing readers, login failures and unavailable summaries remain UNKNOWN.
Idle windows with real fractions can carry a doubt marker when their reset time matches
fetch time plus window length; availability alone is never reported as unused capacity.
`headroom doctor` distinguishes the native reader, login state and successful quota read.
`--shape` is not available for this local source; use status JSON and doctor.

## Gemini CLI (retired in Headroom)

[Google ended consumer Gemini CLI access on June 18, 2026](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/),
including free, Google AI Pro and Ultra subscriptions. Google still supports some enterprise
and paid API use, but Headroom does not support those Gemini CLI configurations.

Old Gemini credential files are ignored by discovery. Existing `vendor = "gemini"`
accounts remain parseable for compatibility and return UNKNOWN with migration guidance;
they make no network calls. Remove those entries from `accounts.toml` and configure
Antigravity instead. Historical Gemini observations remain in the database.

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

Kimi is Moonshot's subscription (the Kimi app and the Kimi Code CLI). There are two credential
sources, and Headroom prefers the first:

1. **The Kimi Code CLI's own OAuth credential**, at `~/.kimi-code/credentials/kimi-code.json` (or
   the same path under `KIMI_CODE_HOME`). If you are signed in with the CLI, there is nothing to
   copy by hand. Headroom reads the `access_token` out of that file and calls
   `GET https://api.kimi.com/coding/v1/usages` with it. To create or replace it, run `kimi login`.
2. **A token file you write yourself**, for anyone who only has the desktop app, read against the
   web gateway below.

The CLI credential is read and never written, and its `refresh_token` is never used or returned:
Headroom does not refresh a credential another tool owns. An access token whose recorded
`expires_at` has passed (or passes within the next minute), or whose own JWT `exp` has passed, is a
`failed` reading with the reason "Kimi CLI credential expired; run: kimi login (Headroom never
refreshes it)" and costs no vendor request. The file must be a regular file you own, mode 0600, and
at most 16 KiB; a symlink, a foreign-owned file, one readable by group or other, or anything that
is not the CLI's own JSON shape is refused. The request carries the access token and the CLI's
`x-msh-platform` value and nothing else -- Headroom deliberately leaves out the hostname, OS version
and device-id headers the CLI itself sends, and never creates the CLI's `device_id` file.

From that response `<principal>:main` carries the plan allowance (labelled with the vendor's
documented 7-day period, which the response declares no window of its own for) plus every
rate-limit window the response does declare, and the plan name comes from the response's own
membership level, so no web session is needed for it. A bucket that ever names itself in that
response gets its own `<principal>:<slug>` meter instead of sharing `main`. The endpoint reports no
shared subscription pool and no membership 7-day ratio, so that source emits neither of those
meters.

The second source, the manual token file, calls the same Connect-style gateway the Kimi Code
console itself uses, at `https://www.kimi.com/apiv2`:

- `kimi.gateway.billing.v1.BillingService/GetUsages`, body `{"scope": ["FEATURE_CODING"]}`. This is
  the required call and the only one whose failure fails the read.
- `kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats`, body `{}`, for the shared
  subscription pool and the membership 7-day Code ratio.
- `kimi.gateway.membership.v2.MembershipService/GetSubscription`, body `{}`, for the plan title.

The last two are best effort: a failure there costs the plan name or the pool meter, never the
allowance read.

Its credential location is **a file you write yourself**, named by `location` in `accounts.toml`
(default `~/.kimi/auth.token`). It must be a regular file you own, mode 0600, containing only the
token and nothing else. The desktop app is not read automatically on purpose: it keeps its session
token in its own Chromium cookie database (`~/Library/Application Support/kimi-desktop/Cookies`),
and reading another application's cookie store is outside this project's threat model, so Headroom
never opens it. To fill the file: sign in at `https://www.kimi.com/code/console`, copy the
`kimi-auth` token from your own session, write it to that path and `chmod 600` it. The adapter
refuses a symlink, a file owned by someone else, a file readable by group or other, anything over
8 KiB, and any content that is not one bare token.

Either credential is held in memory for the length of one poll and is never logged, stored, or
written anywhere; every failure reason is redacted before it is recorded. `location` decides which
source is used: a file named `kimi-code.json` is read as the CLI credential, anything else as a
manual token file. `headroom accounts discover` adds one `kimi` principal pointing at whichever
exists, the CLI credential first, and `headroom doctor` reports whether that file is present and
still 0600 (its fix is `kimi login` for the CLI credential, a fresh paste for the token file).

Meters emitted on the gateway source: `<principal>:main` carries the FEATURE_CODING allowance window plus every
rate-limit window the same response declares (the 5-hour bucket on current plans), the way Codex's
`main` carries both its 5-hour and weekly windows; `<principal>:total` is the shared subscription
pool (`amountUsedRatio`), which spans every feature and not just Code; `<principal>:code-7d` is the
membership 7-day Code ratio, emitted only when it genuinely diverges from the allowance (within 1
percentage point and 5 minutes of the same reset, it is the same quota read twice and the duplicate
is dropped); `<principal>:credits` is optional, see below. Window kind, window length and reset all
come from the response. The one exception is the allowance bucket, which the gateway reports
without a window of its own: it is labelled with the vendor's documented 7-day period.

Optional extra location, the Moonshot platform balance: if a file named `moonshot.key` sits beside
the credential the principal points at (same directory, same 0600 rules) holding a Moonshot API
key, Headroom also calls
`GET https://api.moonshot.ai/v1/users/me/balance` and emits `<principal>:credits`, a `count` window
with no reset. It is informational, never a gate, and its failure never touches the subscription
meters. Its absence is simply "not configured": no meter, no failure row. A principal on the CLI
credential also accepts the documented default `~/.kimi/moonshot.key`, so moving from one source to
the other does not silently drop an already configured credits meter. Only the international host
is called; there is no `api.moonshot.cn` path.

All three hosts (`api.kimi.com`, `www.kimi.com`, `api.moonshot.ai`) are on the outbound allowlist
and nothing else in this adapter may leave the machine; redirects are refused rather than followed,
and responses are size- and depth-bounded like every other vendor read.

Known limitations:

- On the CLI source, a 401 or 403 fails the read with "Kimi rejected the CLI credential (401); run:
  kimi login". Headroom cannot repair that itself, because repairing it means spending the refresh
  token it refuses to touch.
- A 401 on the token-file source fails the read with "Kimi rejected the token (401); sign in at
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
