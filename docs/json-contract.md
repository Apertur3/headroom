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
that it predates the envelope.

`history` (a command with no equivalent MCP tool) is also a bare array and is
out of scope for this version of the contract; it is not enveloped either.

## Shared vocabulary

These fields recur across almost every output. They are documented in full in
[concepts.md](concepts.md); this is the short version for a reader who only
needs the JSON meaning.

- **`freshness`** -- `"fresh" | "stale" | "failed" | "not_enforced"`, on every
  `Observation`. `fresh` is a good recent read. `stale` is older than the
  staleness threshold (15 minutes by default). `failed` is an errored,
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

## Per-output reference

Each entry gives the shape and, where the CLI has an exit code beyond the
generic ones below, what it means. Optional fields (present only in specific
cases) are marked; every other field is always present, though its value may
be `null`.

**Exit codes that apply everywhere**: `0` success; `1` a CLI usage error or an
unhandled exception (printed to stderr as `headroom error: ...`, never as
JSON). Where a command's own exit codes differ from that, they are called out
below.

### `status` (`headroom --json` / `--threshold N --json`, MCP `quota_status`)

CLI: `{ contract, generated_at, observations: Observation[], leases: Lease[],
threshold?: {...} }`. `threshold` is present only with `--threshold N`:
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
string | null` (added by `withResetsIn`, computed fresh at response time, not
stored); `observed_at`, `fetched_at` (both ISO strings); `source` (string,
free-form vendor/adapter tag); `truth`; `freshness`; `confidence`;
`adapter_version`, `upstream_schema_version` (both strings); `reason?: string
| null`; `metadata?: {...}` (optional, vendor facts -- see `types.ts`, never
credentials or prompt content); `burn_percent_per_hour?: number | null`,
`empty_in_seconds?: number | null`, `sustainable_percent_per_hour?: number |
null` (present once pace-enriched, which every `status`/`can`/`gate`/`rate`
read is); `id?: number` (present once read back from the store, as every
`--json` reading is).

Exit codes: `2` when `--threshold` finds a blocking window; `3` when at least
one source failed but at least one observation still exists; `1` when at
least one source failed and there are no observations at all; `0` otherwise.

MCP `quota_status` (direct, no daemon): `{ contract, generated_at, source:
"direct", observations: Observation[], failures: string[] }` -- note the
different top level from the CLI (`failures` instead of `leases`/`threshold`;
no `--threshold` equivalent). **Over a daemon**, `quota_status` answers with
the same bare `Observation[]` array the daemon's own `status` RPC method
returns -- not enveloped; see "CLI vs MCP: daemon vs direct" below.

### `can` (`headroom can <class> --owner X --json`, MCP `quota_can`)

CLI: `{ contract, generated_at, allowed: boolean, meter: string, state:
PaceState, reason: string, meters: MeterPaceDecision[], local_preference?:
"fallback" | "prefer" | "never", local_meter_considered?: boolean, cost:
CostEstimate, leased_id: string | null }`. `MeterPaceDecision` is `{ meter,
state, reason }`. `CostEstimate` is `{ action_class: string, expected_percent:
number | null, source: "given" | "learned" | "unknown", confidence: "none" |
"low" | "medium" | "high", sample_count: number, median_percent: number |
null, iqr_low: number | null, iqr_high: number | null,
max_more_before_reset: number | null }`.

Exit codes: `2` when refused (`allowed: false`); `0` when allowed.

MCP `quota_can`: `{ contract, generated_at, source?: "direct", decision:
CanDecision, cost: CostEstimate, leased_id: string | null }` -- the same
`allowed`/`meter`/`state`/`reason`/`meters`/`local_preference`/
`local_meter_considered` fields as the CLI's top level, nested one level
under `decision` instead. `source` is present only over the direct (no
daemon) fallback.

### `gate` (`headroom gate --need ... --json`, MCP `quota_gate`)

`{ contract, generated_at, allowed: boolean, reason: string, meters_checked:
string[], not_enforced?: Array<"5h" | "wk">, unknown?: true,
lanes_remaining_for_class?: number | null }`. `not_enforced` lists needs
skipped because their window is not enforced on the deciding meter --
informational, never a refusal on its own. `unknown: true` (present only on
some refusals) means the refusal is because a needed window's usage could not
be read at all, not because a known usage simply does not fit -- render it
like an UNKNOWN reading, not a plain "no". `lanes_remaining_for_class` is
present only with `--class`/`action_class` and a learned cost for it.

Exit codes: `2` when refused (`allowed: false`, `unknown` or not); `0` when
allowed.

MCP `quota_gate` adds `source?: "direct"` over the same fields.

### `plan` (`headroom plan --meter M --until reset --json`, MCP `quota_plan`)

Success: `{ contract, generated_at, meter: string, weekly_remaining_percent:
number, reserve_percent: number, hours_per_window: number,
remaining_5h_windows: number, points_per_5h_window: number,
plan_line_percent_per_hour: number }`. Failure (the meter has no weekly
window, or it is stale/failed/unpolled too long): `{ contract, generated_at,
meter: string, error: string }` -- a data state, not a CLI failure; the CLI
renders it as an UNKNOWN line and always exits `0`.

Exit codes: always `0`.

MCP `quota_plan` adds `source?: "direct"` over the same two shapes.

### `fill` (`headroom fill --meter M --until-reset --json`, MCP `quota_fill`)

Success: `{ contract, generated_at, meter: string, lanes: { lanes: number,
points_used: number, reason: string } | null, lanes_error: string | null,
classes: FillClassFit[], used_5h_percent: number | null,
used_weekly_percent: number | null, resets_in_seconds: number | null,
lane_cost_percent: number | null, lane_cost_source: "given" | "learned" |
"unknown", allowance_basis: "full" | "pro_rata", window_used: string }`.
`lanes` is `null` only with no `--lane-cost` and no learned cost for the
meter yet (`lanes_error` then names why); the per-class `classes` list stands
on its own either way. `FillClassFit` is `{ action_class: string, percent:
number, duration_minutes: number, fits: number }`, one row per `routing.toml`
`[cost.<class>]` section (or a learned per-class cost where one exists).
Failure (no enforced window at all, or one that is stale/failed/unpolled too
long): `{ contract, generated_at, meter: string, error: string,
no_enforced_window?: true }` -- rendered as an UNKNOWN line, exit `0`.

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
meter has no enforced window at all (its own latest reason, e.g. a pending
Keychain grant) -- absent on every real per-window line. The three
`attributed_*` fields are set only when `--owner`/`owner` was given: that
owner's ledger-attributed share of the same lookback window. Exit codes:
always `0` for a real reading; a genuine usage error (e.g. `--minutes` not a
number) throws and exits `1`.

MCP `quota_rate`: enveloped, `{ contract, generated_at, source?: "direct",
lines: RateLine[] }`; over a daemon, the bare `RateLine[]` instead.

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
null }`. `EventKind` is `"reset_seen" | "free_reset_granted" |
"free_reset_used" | "credits_changed" | "plan_changed" | "source_failed" |
"source_recovered" | "lease_started" | "lease_ended" |
"pace_projection_conserve" | "model_new"` -- an enumeration that only grows
under the compatibility promise below. `last_seen_at` is set only on an open
`source_failed` event (the most recent poll that still found the same
failure); `null` on every other kind. Exit codes: always `0`.

MCP `quota_events`: enveloped, `{ contract, generated_at, source?: "direct",
events: HeadroomEvent[] }`; over a daemon, the bare `HeadroomEvent[]` instead.

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

## CLI vs MCP: daemon vs direct

A handful of commands/tools (`status`/`quota_status`, `cost`/`quota_cost`,
`rate`/`quota_rate`, `spend`/`quota_spend`, `events`/`quota_events`,
`lease list`/`quota_leases`) can answer from a running daemon's cache or, with
none running, read the store directly. For every one of these, a **daemon**
answer is the bare array the underlying store method returns; a **direct**
(no daemon) answer is wrapped as `{ source: "direct", ... }` by `src/mcp.ts`'s
own `direct*` handlers -- a pre-existing convention from before this contract.
This contract's envelope only ever applies to an object, so it stacks
differently depending on the command:

- **CLI** `status` and `lease list` always end up enveloped: `src/cli.ts`
  reshapes both into an object (`{ observations, leases }` /
  `{ leases }`) before deciding daemon vs direct, so the envelope always
  applies regardless of which one answered.
- CLI `cost`, `rate`, `spend`, and `events` print the bare array unchanged
  either way -- never enveloped, daemon or direct (see "Array-shaped
  outputs").
- **MCP**, every tool's result is enveloped only when it is already an
  object. A **direct** answer always is (the `source: "direct"` wrapper).
  A **daemon** answer for `quota_status`, `quota_cost`, `quota_rate`,
  `quota_spend`, and `quota_leases` is the same bare array the daemon
  returns over its own RPC -- not enveloped. `quota_events` daemon answers
  the same way. Every other MCP tool (`quota_can`, `quota_gate`,
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
