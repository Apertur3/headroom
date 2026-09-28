# The JSON contract

Every machine-readable Headroom output -- a CLI `--json` result and an MCP tool
result -- is meant to be safe to script against without re-reading this
project's source first. This document is that reference: what each output
contains, which fields can be `null` or absent, what the shared vocabulary
(`freshness`, `truth`, `confidence`, `reason`, the pace states) means, the exit
code for each command, and the promise Headroom makes about how this shape can
change in the future.

`headroom contract` prints the current contract version and this file's path.

## The envelope

Every enveloped output -- see "Array-shaped outputs" below for the ones that
are not -- carries two fields at the top level, added by `src/json-contract.ts`
and never present anywhere else in the payload:

| Field | Type | Meaning |
|---|---|---|
| `contract` | string | The contract version, currently `"1.0"`. Constant across every enveloped output in one Headroom version; see the compatibility promise below for when it changes. |
| `generated_at` | string (ISO 8601) | When this response was assembled, not when the underlying reading was taken -- an observation's own `fetched_at`/`observed_at` is the thing to compare against a poll interval. |

The envelope is added once, at the single point in `src/cli.ts` (per command)
or `src/mcp.ts` (one shared point for every tool) that assembles the final
JSON, after every existing field -- so a payload field that happened to be
named `contract` or `generated_at` could never shadow the real ones, though no
current output has one.

## Array-shaped outputs

`cost`, `rate`, `spend`, and `events` (CLI `--json`, and the MCP tools of the
same name answered by a daemon -- see "CLI vs MCP: daemon vs direct" below)
print a bare JSON array, not an object, and predate this contract. A bare
array has no top level to add named fields to without becoming a different
shape entirely, which is exactly the kind of change the compatibility promise
below forbids doing silently. Rather than break every existing script that
reads `JSON.parse(output)[0]`, these four stay bare arrays with no `contract`
or `generated_at` field. Each one is still fully documented below, and its
field shape is still snapshotted by `test/json-contract.test.ts` -- a rename
or removal there fails CI exactly like it would for an enveloped output. A
future major version may convert them to `{ contract, generated_at, ... }`
objects; until then, treat "this output is an array" itself as the signal
that it predates the envelope. `models` (added after this list was written)
is deliberately bare for the same reason `events` is: a sibling list output,
read the same way.

`history` (a command with no equivalent MCP tool) is also a bare array and is
out of scope for this version of the contract; it is not enveloped either.
Like `rate`/`events`, a daemon socket that exists but did not answer health
even after one retry still serves this same bare array, read-only from the
store's last-written rows -- flagged only on stderr, never a field on the
array itself.

## Shared vocabulary

These fields recur across almost every output. They are documented in full in
[concepts.md](concepts.md); this is the short version for a reader who only
needs the JSON meaning.

- **`freshness`** -- `"fresh" | "stale" | "failed" | "not_enforced"`, on every
  served `Observation`. `fresh` is a good recent read. A row stored as
  `fresh` is served as `stale` once its `fetched_at` is older than the
  staleness threshold (15 minutes by default); its `reason` begins `last
  accepted reading <age> ago` and retains any stored explanation after it.
  An unparsable `fetched_at` is also served stale rather than fresh. State and
  count observations do not use this percent-window age gate. This
  response-time label does not rewrite history. `failed` is an errored,
  timed-out, or contradicted read. `not_enforced` means the vendor confirmed
  there is no cap at all on this window -- it never counts as UNKNOWN and
  never blocks `can`/`gate`/`fill`.
- **`truth`** -- `"official" | "estimated"`. `official` came straight from the
  vendor's own meter. `estimated` is Headroom's own inference (a local pool's
  session-log estimate, a vendor-reported idle window that might be a
  placeholder, `/usage`-paste-derived readings, and `--models`' token-share
  read).
- **`confidence`** -- a 0-1 number. On an `Observation` it reflects how much
  the reading itself should be trusted (lower for `estimated`). On a
  `HeadroomEvent` it reflects how sure Headroom is that the inferred event
  (e.g. a reset) actually happened. On a `SpendRow` it is a share-weighted
  mean confidence across the underlying ledger rows: 1 when one owner held
  the meter alone, 1/n when n owners overlapped, 0.5 for the `unattributed`
  row.
- **`reason`** -- a short, human-readable string naming why a state holds
  (why a window is UNKNOWN, why `can`/`gate` refused, why an event fired).
  Present or `null` depending on the field; where it is a plain string
  (never null) it is still allowed to be an empty explanation in principle,
  though in practice every reason is non-empty. Treat its exact wording as
  UI text, not a stable enum -- match on the structured fields beside it
  (`allowed`, `state`, `freshness`, `crossed`) instead of parsing `reason`.
- **Pace states** (`PaceState`) -- `"HARVEST" | "NORMAL" | "CONSERVE" |
  "FREEZE" | "UNKNOWN" | "NOT_ENFORCED" | "UP" | "BUSY" | "DOWN"`. The first
  five apply to a normal percent-based window: `HARVEST` is more than 10
  points ahead of a straight-line pace to reset, `CONSERVE` more than 10
  points behind (or projected to empty before reset), `NORMAL` in between (and
  during the opening grace period), `FREEZE` once usage passes the freeze
  reserve, `UNKNOWN` when the reading is stale, failed, or a needed window was
  never read. `NOT_ENFORCED` is a vendor-confirmed absent cap. `UP`/`BUSY`/
  `DOWN` are local-pool states, not percent-based at all. This enumeration
  only grows under the compatibility promise below; a caller with a `switch`
  or a strict union type should have a default/fallback arm for a state added
  after it was written.

- **`host`** (`HostHealth`) -- `{ state: "ok" | "warn" | "refuse" | "unknown",
  reasons: string[], load_ratio: number | null, pty_used: number | null,
  pty_max: number | null, orphans: number | null }`. One read of local host
  pressure (`src/host-health.ts`; see docs/concepts.md's "Host guard" section
  for why it exists): CPU load-per-core, pseudo-terminal usage, and orphaned
  `agy` processes. Any
  measurement is `null` ("unknown") when its probe is unsupported on this
  platform or itself failed -- never treated as pressure. Carried, purely
  additively, on `can` and `gate` (CLI and MCP) so an orchestrator sharing this
  machine can see local pressure alongside a quota decision; neither of those
  two ever refuses over it. Only `headroom run`, which launches a child
  process on this machine, actually refuses on `state: "refuse"`, and only
  when `host_guard.mode = "refuse"` (the default) in policy.toml.

## Per-output reference

Each entry gives the shape and, where the CLI has an exit code beyond the
generic ones below, what it means. Optional fields (present only in specific
cases) are marked; every other field is always present, though its value may
be `null`.

**Exit codes that apply everywhere**: `0` success; `1` a CLI usage error or an
unhandled exception, printed to stderr as `headroom error: ...`. A `--json`
invocation additionally prints `{"error": "<message>"}` to stdout in this
case (nothing else on stdout that run) -- added so a `--json` caller can never
see empty stdout and mistake "no answer at all" for "a reading with nothing in
it" (an empty `observations`/bare-array result is still valid JSON, just a
different shape than this error object). Where a command's own exit codes
differ from the `0`/`1` pair above, they are called out below.

### `status` (`headroom --json` / `--threshold N --json`, MCP `quota_status`)

CLI: `{ contract, generated_at, observations: Observation[], leases: Lease[],
plan_downgraded: { principal, from, to, since, acknowledged } | null,
disabled_principals: string[], heartbeats: Heartbeat[], due_timers: Timer[],
threshold?: {...} }`. `disabled_principals` is always present (empty when
none): its principals are configured with `enabled = false`, so their stored
observations are omitted rather than reported as current capacity. MCP
`quota_status` carries the same additive field. The daemon JSON-RPC `status`
result stays the `Observation[]` array it has always been -- the 1.x contract
forbids turning it into an object -- so `disabled_principals` is derived by
the CLI and MCP layers from the registry, not returned by the daemon method
itself. `heartbeats` is every registered orchestrator heartbeat (see
`heartbeat list` below); `due_timers` is every pending `Timer` (see `timer
list` below) already at or past its own `at`.
`threshold` is present only with `--threshold N`:
`{ percent: number, windows: ThresholdWindow[], any_crossed: boolean,
any_blocking: boolean }`, where each `ThresholdWindow` is `{ meter_id: string,
window_minutes: number | null, used_percent: number | null, crossed: boolean,
blocking: boolean, freshness }`.

An `Observation` (the unit everything else builds on) is: `principal_id`,
`meter_id` (string, `principal:meter`); `window: { kind: "rolling" | "fixed" |
"count" | "state", minutes: number | null, enforcement: "hard" | "soft" } |
null`; `quantity: { used: number, limit: number | null, remaining: number |
null, unit: "percent" | "tokens" | "requests" | "credits" } | null`;
`resets_at: string | null`; `resets_in_seconds: number | null` and `resets_in:
string | null` (computed fresh at response time, not stored). These retain
their contract-1.0 meanings: a due or overdue reset has `resets_in_seconds:
0` and `resets_in: "0m"`. Agents check additive `reset_overdue: true` to
identify an overdue schedule, and read its additive `reset_overdue_seconds:
number` for the number of seconds since it was due; both fields are absent
otherwise. Human output renders that state as `overdue <age>`. A reset within
the 60-second tolerance has no overdue fields and remains `0m`. `observed_at`,
`fetched_at` (both ISO strings); `source` (string,
free-form vendor/adapter tag); `truth`; `freshness`; `confidence`;
`adapter_version`, `upstream_schema_version` (both strings); `reason?: string
| null`; `metadata?: {...}` (optional, vendor facts -- see `types.ts`, never
credentials or prompt content). `metadata.vendor_inconsistent?: boolean` is
`true` when adjacent vendor reads disagreed about the window identity; status
then keeps showing the earlier window while Headroom waits for a second
matching poll. `metadata.vendor_window_held?: boolean` marks that same
frozen earlier reading while a new window identity awaits confirmation.
Either flag puts the pace state at UNKNOWN immediately -- at any age, not
only once the reading has also aged past `staleness_minutes` -- everywhere a
pace decision is made (`status`, `gate`, `fill`, `plan`, `route`, `can`, and
`--threshold`). Flagged raw rows remain available in history but do not
affect burn or pace. `burn_percent_per_hour?: number | null`,
`empty_in_seconds?: number | null`, `sustainable_percent_per_hour?: number |
null` (present once pace-enriched, which every `status`/`can`/`gate`/`rate`
read is); `last_known?: { used_percent: number, resets_at: string | null,
observed_at: string, age_seconds: number, window_minutes?: number | null } |
null` (present once last-known-enriched, which every `status` read is;
non-null only when this observation's served `freshness` is `failed` or `stale`
-- the two values that always render as UNKNOWN -- and a fresh reading exists
within the last 7 days; the newest such reading, so a fail-closed caller can
still see the trend behind an UNKNOWN. For a windowed observation this is the
newest fresh reading of that same meter and window. For a windowless one
(`window: null`, what a credential-read or transport failure produces --
the failure speaks for the whole meter, not one window of it) it is instead
the newest fresh reading from the tightest window of that meter (smallest
minutes, i.e. nearest reset) that still has one in range, and `window_minutes`
names which window that is -- present only in this borrowed case, absent when
`last_known` already shares the observation's own window. Informational only:
`can`/`gate`/`route` keep treating UNKNOWN as no capacity regardless of what
this carries); `credits_lapsed?: boolean` is present and `true` only on an
enriched credits observation whose `resets_at` expiry is in the past (it is
computed at response time; the stored fact is never rewritten); `id?: number` (present once read back from the store, as
every `--json` reading is); `status_enriched_at?: string` (the response-time
instant that most recently set freshness, pace, last-known and reset fields.
This marker records when enrichment last ran, never a license to skip
re-running it: every renderer re-evaluates freshness and pace against its
own current serving clock on every render, whether or not a row already
carries this marker, so a row served fresh at that instant but read again
later -- a cached CLI payload, a long-lived dashboard -- is re-served
UNKNOWN once it has since aged past `staleness_minutes`, with `last_known:
null` rather than a store-backed lookup it cannot re-run. A newer CLI or MCP
server locally adds this marker and the matching fields, from a read-only,
non-migrating store lookup, when an older daemon returns an unmarked status
array, using the current policy, before it serializes or evaluates the row;
if that lookup is unavailable, enrichment still happens locally without
history).

Exit codes: `2` when `--threshold` finds a blocking window; `3` when at least
one source failed but at least one observation still exists; `1` when at
least one source failed and there are no observations at all; `0` otherwise.

`served_from: "cache"` and `daemon: "unresponsive"` are additive fields, present
only when a daemon socket exists but did not answer `health` even after one
retry: the reading was served from the store's own last-written rows,
read-only, with freshness/pace still computed against the current clock (a
stale row still serves stale). Absent on every other read, daemon-answered or
direct alike.

MCP `quota_status`: `{ contract, generated_at, source?: "direct" | "cache",
daemon?: "unresponsive", observations: Observation[], plan_downgraded: {
principal, from, to, since, acknowledged } | null, heartbeats: Heartbeat[],
due_timers: Timer[], failures?: string[] }`. `heartbeats`/`due_timers` are
the same additive fields as the CLI's own `status` (above), present over
every path -- daemon, direct, and cache -- for CLI/MCP parity. Direct reads
carry `source: "direct"` and `failures`; a cached read (daemon present but
unresponsive after one retry) carries `source: "cache"`, `daemon:
"unresponsive"`, and `failures: []`; daemon reads omit `source` and `daemon`
entirely. There is no `--threshold` equivalent.

### `can` (`headroom can <class> --owner X --json`, MCP `quota_can`)

CLI: `{ contract, generated_at, allowed: boolean, meter: string, state:
PaceState, reason: string, meters: MeterPaceDecision[], local_preference?:
"fallback" | "prefer" | "never", local_meter_considered?: boolean, cost:
CostEstimate, leased_id: string | null, host: HostHealth }`.
`MeterPaceDecision` is `{ meter,
state, reason }`. `CostEstimate` is `{ action_class: string, expected_percent:
number | null, source: "given" | "learned" | "unknown", confidence: "none" |
"low" | "medium" | "high", sample_count: number, median_percent: number |
null, iqr_low: number | null, iqr_high: number | null,
max_more_before_reset: number | null }`. `host` is additive (see "Shared
vocabulary" above) -- a fresh local read on every call, regardless of whether
the decision itself came from the daemon or a direct read; it never affects
`allowed`.

Exit codes: `2` when refused (`allowed: false`); `0` when allowed.

`served_from: "cache"`/`daemon: "unresponsive"` apply here exactly as
documented under `status` above, and only without `--lease`: a `can --lease`
call is a dispatch path (it can reserve capacity) and stays fail-closed,
never served from cache.

MCP `quota_can`: `{ contract, generated_at, source?: "direct" | "cache",
daemon?: "unresponsive", decision: CanDecision, cost: CostEstimate, leased_id:
string | null, host: HostHealth }` -- the same `allowed`/`meter`/`state`/`reason`/`meters`/
`local_preference`/`local_meter_considered` fields as the CLI's top level,
nested one level under `decision` instead. `source`/`daemon` are present only
over the direct (no daemon) or cached (daemon present but unresponsive)
fallback, never over a daemon-lease (`lease: true`) call, which stays
fail-closed.

### `gate` (`headroom gate --need ... --json`, MCP `quota_gate`)

`{ contract, generated_at, allowed: boolean, reason: string, meters_checked:
string[], not_enforced?: Array<"5h" | "wk">, unknown?: true,
lanes_remaining_for_class?: number | null, notices: string[], host: HostHealth
}`. `host` is additive (see "Shared vocabulary" above); it never affects
`allowed`. `not_enforced`
lists needs skipped because their window is not enforced on the deciding meter
-- informational, never a refusal on its own. `unknown: true` (present only on
some refusals) means the refusal is because a needed window's usage could not
be read at all, not because a known usage simply does not fit -- render it
like an UNKNOWN reading, not a plain "no". `lanes_remaining_for_class` is
present only with `--class`/`action_class` and a learned cost for it. `notices`
is one line per meter this call checked (`meters_checked`) with an
unscheduled reset (issue #20) in the last 24 hours -- `["unscheduled reset on
codex-main:main at 2026-09-08T01:24:26Z; capacity appeared, re-plan"]` --
empty when none; treat it like a free reset just landed, not like the
scheduled boundary the rest of this result already accounts for.

Exit codes: `2` when refused (`allowed: false`, `unknown` or not); `0` when
allowed.

MCP `quota_gate` adds `source?: "direct"` over the same fields.

### `run` (`headroom run --meter M --need ... --owner X -- <command> --json`)

`{ contract, generated_at, host: HostHealth, gate: CanDecision | null,
lease_id: string | null }`. `host` is always the first thing this command
computes, before the store even opens (see docs/concepts.md's "Host guard"
section). Three distinct outcomes share this shape:

- **Host guard refuses** (`host.state: "refuse"` and `host_guard.mode =
  "refuse"` in policy.toml, the default): `gate: null`, `lease_id: null`,
  nothing was ever gated or leased. The one-line reason (naming the
  measurement and the `host_guard.*` policy key) goes to stderr; `--json`
  suppresses it there and callers should read `host.reasons` instead.
- **Quota gate refuses** (host guard did not refuse, but the vendor-reported
  window does not fit): `gate: CanDecision` with `allowed: false`, `lease_id:
  null`.
- **Launched**: `gate: CanDecision` with `allowed: true`, `lease_id` the
  reservation covering the child process's run.

A `host.state: "warn"` reading (or a `"refuse"` reading under `host_guard.mode
= "warn"`) never changes this shape or the exit code -- it only adds a
stderr warning line, in every case above, including a successful launch.

Exit codes: `2` for either refusal above (host guard or quota gate); otherwise
the launched child process's own exit code (`1` if the executable itself
could not start; `130`/`143` if this `headroom run` process received
SIGINT/SIGTERM while the child was running).

### `credits` (`headroom credits [set|clear] --json`)

List: `{ contract, generated_at, credits: [{ principal: string, meter: string,
available: number, expires_at: string | null, source: "vendor" | "manual",
lapsed: boolean }] }`. `available` is zero once the expiry has passed, while
`lapsed` preserves why. `set` and `clear` return the same per-meter object as
`{ contract, generated_at, credit: {...} }`.

A manual set is stored as an ordinary observation on `<principal>:credits`:
`{ principal_id, meter_id, window: { kind: "count", minutes: null,
enforcement: "hard" }, quantity: { used: 0, limit: null, remaining: number,
unit: "credits" }, resets_at: string, source: "manual", truth: "estimated",
freshness: "fresh", confidence: 0.9, adapter_version: "manual",
upstream_schema_version: "manual", metadata: { free_resets_available: number,
manual: true } }`. `clear` keeps the same shape with `remaining: 0` and adds
`metadata.manual_cleared: true`; neither operation deletes prior history.
A date-only `expires` input is stored as midnight UTC and credit status renders its UTC calendar
day, so the displayed day and lapse boundary do not change with the machine timezone.

### `plan` (`headroom plan --meter M --until reset [--target P] --json`, MCP `quota_plan`)

Success: `{ contract, generated_at, meter: string, weekly_remaining_percent:
number, reserve_percent: number, hours_per_window: number,
remaining_5h_windows: number, points_per_5h_window: number,
plan_line_percent_per_hour: number, usable_now_percent: number, banked: {
available: number, expires_at: string | null, source: "vendor" | "manual" |
null, lapsed: boolean, worth_percent: number }, target?: { points: number,
fits_now: boolean, fits_with_banked: boolean, resets_needed: number | null }, advice:
{ use_now: boolean, reason: string, use_before: string | null }, notices:
string[] }`. Failure (the meter
has no weekly window, or it is stale/failed/unpolled too long): `{ contract,
generated_at, meter: string, error: string, notices: string[] }` -- a data
state, not a CLI failure; the CLI renders it as an UNKNOWN line and always
exits `0`. `notices` is the same unscheduled-reset line `gate` carries above
(issue #20), scoped to this one meter; empty when none.
`resets_needed` is `null` when the reserve gives each banked reset zero usable points and the
target does not already fit; `advice.use_now` is then always `false`. A banked count is only a
manual entry or a fresh, unheld vendor observation marked `free_resets_available`; other credits
counts remain informational and contribute zero.

Exit codes: always `0`.

MCP `quota_plan` adds `source?: "direct"` over the same two shapes.

### `fill` (`headroom fill --meter M --until-reset --json`, MCP `quota_fill`)

Success: `{ contract, generated_at, meter: string, lanes: { lanes: number,
points_used: number, reason: string } | null, lanes_error: string | null,
classes: FillClassFit[], used_5h_percent: number | null,
used_weekly_percent: number | null, resets_in_seconds: number | null,
lane_cost_percent: number | null, lane_cost_source: "given" | "learned" |
"unknown", allowance_basis: "full" | "pro_rata", window_used: string,
notices: string[] }`. `lanes` is `null` only with no `--lane-cost` and no
learned cost for the meter yet (`lanes_error` then names why); the per-class
`classes` list stands on its own either way. `FillClassFit` is `{
action_class: string, percent: number, duration_minutes: number, fits:
number }`, one row per `routing.toml` `[cost.<class>]` section (or a learned
per-class cost where one exists). `notices` is the same unscheduled-reset
line `gate`/`plan` carry above (issue #20), scoped to this one meter; empty
when none. Failure (no enforced window at all, or one that is stale/failed/
unpolled too long): `{ contract, generated_at, meter: string, error: string,
no_enforced_window?: true, notices: string[] }` -- rendered as an UNKNOWN
line, exit `0`.

Exit codes: `2` when `lanes` is `null` or `lanes.lanes` is `0`; `0` otherwise
(including the UNKNOWN/error case above).

MCP `quota_fill` adds `source?: "direct"` over the same two shapes.

### `route` (`headroom route --class C --owner X --json`, MCP `quota_route`)

`{ contract, generated_at, principal: string | null, environment:
Record<string, string>, reason: string, candidates: RouteCandidate[] }`.
`principal` is `null` when no candidate both fits and has a rankable
remaining percent. `environment` is the launch environment variable(s) for
the winning principal (e.g. `{ CLAUDE_CONFIG_DIR: "..." }`), empty for a
vendor's own default profile or a vendor `route` has no such variable for
(Antigravity, a local pool), and always empty when `principal` is `null`.
`RouteCandidate` is `{ principal: string, state: PaceState, reason: string,
remaining_percent: number | null, reserve_percent: number, window_minutes:
number | null }` -- every candidate `routing.toml`'s `[consumes]` entry
allows, not only the winner.

Exit codes: `2` when `principal` is `null`; `0` otherwise.

MCP `quota_route` adds `source?: "direct"` over the same fields (`route` is
always a direct read, CLI and MCP alike -- there is no daemon RPC case for
it).

### `inbox` (`headroom inbox --session S --json`, MCP `quota_inbox`)

`{ contract, generated_at, session: string, messages: InboxMessage[],
remaining: number }`. `InboxMessage` is `{ file: string, session: string,
kind: "budget" | "note" | "handoff", at_epoch: number, at: string, from:
string | null, body: unknown }` -- `body` is the sender's parsed JSON payload
when it was valid JSON, the raw text otherwise. `remaining` is how many more
unread messages are still queued beyond the ones returned in this call.

Reading is destructive: each message returned here is marked read and will
not appear again. `headroom inbox send` (not `quota_inbox`, which is
read-only) has no `--json` output of its own -- it prints one plain
confirmation line.

Exit codes: always `0`.

MCP `quota_inbox` adds `source: "direct"` (inbox has no daemon RPC case
either) over the same fields.

### `lease list` (`headroom lease list --json`, MCP `quota_leases`)

`{ contract, generated_at, leases: Lease[] }`. `Lease` is `{ id: string,
owner: string, meter_id: string, expected_percent: number | null, note:
string | null, action_class: string | null, started_at: string, expires_at:
string, ended_at: string | null, ended_reason: string | null, spent_percent:
number, already_ended?: boolean }`. `already_ended` appears only in the
response to `lease end`, never in a list.

`lease start` and `lease end` have no `--json` output of their own on the
CLI (`start` prints the new lease's id; `end` prints one confirmation line);
`lease end` exits `1` on an owner mismatch without `--force`, `0` otherwise.
`lease list --json` always exits `0`.

MCP has three tools instead of one CLI subcommand: `quota_lease_start` returns
`{ contract, generated_at, source: "direct", lease: Lease }`; `quota_lease_end`
the same shape (`lease.ended_at`/`ended_reason` now set, and `already_ended:
true` on an idempotent repeat end); `quota_leases` returns `{ contract,
generated_at, source?: "direct", leases: Lease[] }`. `source` is present on
`quota_leases` only over the direct fallback; **over a daemon it answers with
the same bare `Lease[]` array the daemon's `leases` RPC method returns**, not
enveloped -- see "CLI vs MCP: daemon vs direct" below.

### `heartbeat list` (`headroom heartbeat list --json`, MCP `quota_heartbeat`)

`{ contract, generated_at, heartbeats: Heartbeat[] }`. `Heartbeat` is `{
owner: string, interval_ms: number, resume_sentence: string | null,
started_at: string, last_beat_at: string, lapsed_since: string | null,
updated_at: string }`. `lapsed_since` is non-null exactly while the daemon
currently considers this heartbeat overdue by more than 2x its own interval.

`headroom heartbeat --owner X --every D [--resume S]` and `--stop` have no
`--json` output of their own (a plain confirmation line); `heartbeat list
--json` always exits `0`.

MCP `quota_heartbeat` returns `{ contract, generated_at, source: "direct" |
"daemon", heartbeat: Heartbeat }` on a beat, or `{ contract, generated_at,
source, stopped: boolean }` with `stop: true`.

### `timer list` (`headroom timer list --json`, MCP: none -- CLI only)

`{ contract, generated_at, timers: Timer[] }`. `Timer` is `{ owner: string,
name: string, at: string, action: string, if_missed: "notify" | "drop",
created_at: string, fired_at: string | null, cleared_at: string | null }`.
Only pending timers (never fired, never cleared) are listed. `status`'s own
`due_timers` (above) is the subset of this already at or past `at`.

`timer set`/`timer clear` have no `--json` output of their own (a plain
confirmation line); `timer list --json` always exits `0`.

### `cost` (bare array -- see "Array-shaped outputs")

`LearnedCost[]`: `{ action_class: string, sample_count: number,
median_percent: number, iqr_low: number, iqr_high: number }`, one row per
action class with at least one ended lease. Exit codes: always `0`.

MCP `quota_cost`: enveloped, `{ contract, generated_at, source?: "direct",
items: LearnedCost[] }` -- the MCP tool result is an object even though the
CLI's own `--json` for the same data is a bare array (the MCP tools were
designed after the CLI flags, with the "direct" wrapper convention from the
start). Over a daemon it answers with the daemon's bare `LearnedCost[]`
instead, unenveloped.

### `rate` (bare array -- see "Array-shaped outputs")

`RateLine[]`: `{ meter: string, window_minutes: number | null, used_percent:
number | null, burn_percent_per_hour: number | null, empty_in_seconds: number
| null, resets_at: string | null, reason?: string | null, attributed_owner?:
string, attributed_percent?: number, attributed_confidence?: number }`.
`reason` is set only on the synthetic line used when a specifically requested
meter has no enforced window at all (its own latest reason, e.g. a credential
read failure) -- absent on every real per-window line. The three
`attributed_*` fields are set only when `--owner`/`owner` was given: that
owner's ledger-attributed share of the same lookback window. Exit codes:
always `0` for a real reading; a genuine usage error (e.g. `--minutes` not a
number) throws and exits `1`.

The CLI's bare array is unchanged when a daemon socket exists but did not
answer health even after one retry: this reading is still the same bare
array, served read-only from the store's last-written rows -- flagged only on
stderr (`(served from cache; daemon busy, not a fresh read)`), the same
convention the no-daemon direct-read notice already uses, since a bare array
has nowhere to carry a field (see "Array-shaped outputs" above).

MCP `quota_rate`: enveloped, `{ contract, generated_at, source?: "direct" |
"cache", daemon?: "unresponsive", lines: RateLine[] }`; over a daemon, the
bare `RateLine[]` instead. A cached read (daemon present but unresponsive
after one retry) carries `source: "cache"` and `daemon: "unresponsive"`.

### `spend` (bare array -- see "Array-shaped outputs")

`SpendRow[]`: `{ meter_id: string, window_minutes: number | null, owner:
string, attributed_percent: number, confidence: number, samples: number,
from_at: string, to_at: string }`. `owner` is `"unattributed"` for the
movement that happened while nobody held a lease on the meter -- real spend
whose owner simply cannot be known, shown rather than hidden. Exit codes:
always `0`.

MCP `quota_spend`: enveloped, `{ contract, generated_at, source?: "direct",
since: string, rows: SpendRow[] }`; over a daemon, the bare `SpendRow[]`
instead.

### `events` (bare array -- see "Array-shaped outputs")

`HeadroomEvent[]`: `{ id: string, kind: EventKind, origin: "vendor_reported"
| "inferred", confidence: number, evidence_observation_ids: number[],
created_at: string, corrected_by: string | null, meter_id: string | null,
principal_id: string | null, reason: string | null, last_seen_at: string |
null, metadata?: { unscheduled?: boolean; window_minutes?: number | null;
used_percent?: number; previous_used_percent?: number; from_plan?: string;
to_plan?: string; downgrade?: boolean; restored?: boolean;
credit_spent_on_free_plan?: boolean; resets_at?: string; model_id?: string;
model_name?: string | null; shares_pool?: boolean } | null }`.
`EventKind` is `"reset_seen" | "free_reset_granted" |
"free_reset_used" | "credits_changed" | "plan_changed" | "exhausted_reported" |
"window_retired" | "source_failed" |
"source_recovered" | "lease_started" | "lease_ended" |
"pace_projection_conserve" | "model_new" | "grant_lapsed" | "model_available" |
"model_retired"` -- an enumeration that only grows
under the compatibility promise below. `last_seen_at` is set only on an open
`source_failed` event (the most recent poll that still found the same
failure); `null` on every other kind. On a `reset_seen`, `window_minutes`
names the window and `unscheduled: true` marks a reset before its scheduled
instant; `used_percent`/`previous_used_percent` are then the percentages
after and before it. On a `plan_changed`, `from_plan`, `to_plan`, `downgrade`,
or `restored` explain the vendor-reported change. `credit_spent_on_free_plan`
marks a free-plan reset-credit use. `resets_at` may accompany an exhausted
report. On a `model_available`/`model_retired`, `model_id` and `model_name`
name the vendor model. `model_available.shares_pool` is `false` only when a
current fresh official model-scoped meter matches the id, `true` when a
current fresh official generic meter establishes a shared pool, and absent
when neither relationship is observed; absence is UNKNOWN, never capacity.
Metadata is absent when an event has no such fact. Exit codes:
always `0`.

Same cached-read behavior as `rate` above applies here: the CLI's bare array
is unchanged, flagged only on stderr, when a daemon socket exists but did not
answer health even after one retry.

MCP `quota_events`: enveloped, `{ contract, generated_at, source?: "direct" |
"cache", daemon?: "unresponsive", events: HeadroomEvent[] }`; over a daemon,
the bare `HeadroomEvent[]` instead. A cached read carries `source: "cache"`
and `daemon: "unresponsive"`, the same convention `quota_status`/`quota_can`/
`quota_rate` use.

### `models` (bare array -- see "Array-shaped outputs")

`headroom models [--principal <id>] [--json|--agent]` -- distinct from the
`--models` flag documented above, which is Claude session-log token share.
`--principal` accepts exactly one non-flag id (and may appear only once).
`--json`: `KnownModel[]`, `{ principal_id: string, vendor: string, model_id:
string, model_name: string | null, first_seen_at: string, last_seen_at:
string, retired_at: string | null }[]`. `retired_at` is `null` until a later
catalog read no longer lists the id. No MCP equivalent yet. Exit codes:
always `0`.

### `wait` -- MCP only (`quota_wait`)

`headroom wait` itself has no `--json` output (a plain "meter reset" /
"meter UNKNOWN (reason)" line; exit `0` on a reset or an UNKNOWN reading, `3`
on `--max` timing out). `quota_wait` (MCP only, never blocks): `{ contract,
generated_at, source: "direct", meter: string, resets_at: string | null,
resets_in_seconds: number | null, suggested_sleep_seconds: number | null }`.
`suggested_sleep_seconds` is capped at 3600 even when the real reset is
further out, so a caller re-checks rather than sleeping through a long window
uninterruptibly.

### `--models` (`headroom --principal X --models --json`)

`{ contract, generated_at, principal: string, truth: "estimated", source:
"local session logs", window_start: string, window_end: string, models:
Array<{ model: string, input_tokens: number, output_tokens: number,
share_percent: number }> }`. Always `truth: "estimated"`: this is a local
token-count estimate from Claude Code's own session logs, never the vendor's
own percent-of-limit meter. No MCP equivalent. Exit codes: always `0`; a
usage error (no `--principal`, or one that is not a configured Claude
principal) throws and exits `1`.

### `usage --paste` / `--clipboard` -- MCP `quota_usage_paste`

`headroom usage --paste --json` prints the stored `Observation[]` (the same
shape as `status`'s own, `withResetsIn`-enriched) as a bare array -- out of
scope for this version of the contract, listed here only so it is not
mistaken for an oversight. `quota_usage_paste` (MCP, direct only): `{
contract, generated_at, source: "direct", principal: string, observations:
Observation[], unparsed: string[] }`. `unparsed` lists panel lines that
looked like a window header but could not be parsed -- surfaced rather than
silently dropped.

### `export` (present, not yet part of this contract)

`headroom export --format json` (the default) writes its own JSON document,
assembled entirely in `src/export.ts` with its own `schema_version` field --
a different, older versioning concept, not this contract's `contract`/
`generated_at` envelope. Bringing `export` under this contract needs a change
inside `src/export.ts` itself, outside this slice's file ownership; until
then, `export`'s JSON output carries no `contract` field. `--format csv` is
unaffected either way.

### `doctor` (no `--json` yet)

`headroom doctor` has no `--json` output at all as of this contract version
(only `--bundle [path]`, which writes a redacted report file, not stdout
JSON). Nothing to envelope yet; this section exists so a future `doctor
--json` is added with `contract`/`generated_at` from the start rather than as
an afterthought.

### `contract`

`headroom contract` is the one command that is neither JSON nor enveloped --
two plain lines, the version and this file's path:

```
contract 1.0
docs/json-contract.md
```

## CLI vs MCP: daemon vs direct vs cache

A handful of commands/tools (`status`/`quota_status`, `cost`/`quota_cost`,
`rate`/`quota_rate`, `spend`/`quota_spend`, `events`/`quota_events`,
`lease list`/`quota_leases`) can answer from a running daemon's cache or, with
none running, read the store directly. For every one of these, a **daemon**
answer is the bare array the underlying store method returns; a **direct**
(no daemon) answer is wrapped as `{ source: "direct", ... }` by `src/mcp.ts`'s
own `direct*` handlers -- a pre-existing convention from before this contract.
Four of them (`status`/`quota_status`, `history`, `events`/`quota_events`,
`rate`/`quota_rate`, and `can`/`quota_can` without a lease) have a third
answer, **cache**: a daemon socket exists but did not answer health even after
one retry, so the reading is served read-only from the store's last-written
rows instead, wrapped the same way direct is (`source: "cache"`, plus
`daemon: "unresponsive"`) wherever the shape is already an object -- see
"cache" under each of those commands above for the exact fields. This
contract's envelope only ever applies to an object, so it stacks differently
depending on the command:

- **CLI** `status` and `lease list` always end up enveloped: `src/cli.ts`
  reshapes both into an object (`{ observations, leases }` /
  `{ leases }`) before deciding daemon vs direct, so the envelope always
  applies regardless of which one answered.
- CLI `cost`, `rate`, `spend`, and `events` print the bare array unchanged
  either way -- never enveloped, daemon or direct (see "Array-shaped
  outputs").
- **MCP**, every tool's result is enveloped only when it is already an
  object. A **direct** answer always is (the `source: "direct"` wrapper).
  `quota_status` is always an object so it can carry an active plan downgrade.
  A **daemon** answer for `quota_cost`, `quota_rate`, `quota_spend`, and
  `quota_leases` is the same bare array the daemon returns over its own RPC
  and `quota_events` daemon answers the same way. Every other MCP tool (`quota_can`, `quota_gate`,
  `quota_plan`, `quota_fill`, `quota_route`, `quota_wait`,
  `quota_lease_start`, `quota_lease_end`, `quota_inbox`,
  `quota_usage_paste`) is always an object from either source, so it is
  always enveloped.

A caller that wants a guaranteed envelope on `status`/`cost`/`rate`/`spend`/
`events`/`leases` over MCP should either not run a daemon, or check
`Array.isArray(result)` before assuming `result.contract` exists.

## Compatibility promise

Within contract **1.x**:

- Fields are only ever **added**, never renamed or removed, on any enveloped
  or documented output.
- An enumeration (`PaceState`, `EventKind`, a `source`/`freshness`/`truth`
  string union, an exit code) only ever **grows**. Code that matches on one of
  these should have a fallback arm for a value it does not recognize, not
  treat an unrecognized value as an error.
- A field that changes meaning without changing name does not happen; a
  meaning change is a rename in spirit and follows the same rule as one.

A change that would break any of the above -- a field renamed or removed, an
output's top-level shape changed (array to object or the reverse), an
existing enum member repurposed -- bumps the **major** version (2.0) and is
called out under "Breaking" in `CHANGELOG.md`, per the project-wide rule in
[releasing.md](releasing.md). The old 1.x shape stays available for at least
one more minor release behind a `--contract 1` flag before it is removed, so
a caller has a real window to migrate rather than a breaking release landing
with no way to opt out immediately. (`--contract 1` does not exist yet, since
nothing has broken; this sentence is the commitment for when something does.)

`test/json-contract.test.ts` enforces the additive-only half of this promise
mechanically: it snapshots the field shape (which fields exist, and each
one's JSON type) of every output in this document against a fixture under
`test/fixtures/json-contract/`, so a field silently renamed or removed fails
CI with a message pointing back at this file, rather than surfacing later as
a break report from whoever was scripting against it.
