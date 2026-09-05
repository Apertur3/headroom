# Concepts

## Principal

A principal is one credential location Headroom polls: a Claude Code config directory, a Codex
`CODEX_HOME`, the Google login behind Antigravity's `agy`, or a local inference base URL. Two
Claude Code profiles on the same machine are two principals, each with its own stable id.
Antigravity's local and remote paths are two ways of reading the same principal, not two
principals.

Example: `claude-2` is the principal for `~/.claude2`, named that way by
`headroom accounts discover` because it isn't the default `~/.claude`.

## Meter

A meter is one vendor-enforced limit on a principal, addressed as `principal:meter`. Claude has
three: `all`, `fable`, `routines`. Codex has `main`, `spark`, and an informational `credits`
count. Antigravity has `gemini` and `claude-gpt`. A local pool has one, `capacity`.

Example: `codex-main:spark` is the Spark-specific limit on the `codex-main` principal, separate
from `codex-main:main`.

## Window

A window is one bucket inside a meter: a kind (`rolling`, `fixed`, `count`, or `state` for local
pools), a duration in minutes, and whether the vendor enforces it (`hard`) or not (`soft`, used
only by local pools). A meter usually carries two windows, a short rolling one and a longer fixed
one that resets on a calendar boundary.

Example: `claude-main:all` carries a 300-minute rolling window (`5h` in `headroom`'s output) and a
10080-minute fixed window (`wk`).

## Observation

An observation is one sample of one window: how much is used, when it resets, when it was
fetched, which source produced it, and how much Headroom trusts it. Nothing about provenance is
inferred after the fact; a single call to a vendor endpoint can produce several observations, one
per window, each carrying its own freshness and confidence, rather than one mixed "reading" for
the whole account.

Example: an observation for `claude-main:fable` at 82% used, `resets_at` next Saturday 14:00,
`freshness: "fresh"`, `truth: "official"`.

## Freshness and UNKNOWN

Every observation is `fresh`, `stale`, `failed`, or `not_enforced`. `fresh` is a good, recent
vendor read. `stale` means the last good read is older than the staleness threshold (15 minutes by
default). `failed` means the last attempt errored, timed out, or the vendor returned data Headroom
won't trust, such as an Antigravity availability-only payload. `not_enforced` is different from
the other three: it means the vendor confirmed there is no cap on this window at all, so it prints
as `n/a` and never counts toward `can` or a threshold. Anything `stale` or `failed` becomes the
pace state UNKNOWN everywhere Headroom shows it, and `headroom can` answers NO for it unless you
pass `--allow-unknown`. UNKNOWN is never treated as capacity.

Example: a Codex account with no 5-hour window in the vendor's response and no recent session log
shows `5h n/a`, not `5h 0%`.

## Pace states

Each enforced window gets a pace state from a straight-line burn against the time since its last
reset: HARVEST when usage is more than 10 points ahead of that line, CONSERVE when it's more than
10 points behind, NORMAL in between, FREEZE once usage passes the freeze reserve (10% of the limit
left, by default), and UNKNOWN when the observation itself is stale or failed. Right after a reset
there's a grace period, the first 10% of the window's duration by default, during which Headroom
reports NORMAL instead of computing pace off a near-empty window and calling a normal opening
burst CONSERVE.

Example: a 5-hour window that resets at 17:10 and shows 3% used at 17:15 is still in its grace
period and reports NORMAL, not HARVEST.

## Burn rate and projection

Every enforced window's `burn_percent_per_hour` is a least-squares slope fit through that window's
own fresh, same-window observations from the last 60 minutes (a shorter or longer lookback for
`headroom rate`'s own reading, `--minutes` or `--window`). Fewer than two samples in the lookback
leaves it null -- there's nothing to fit a line through yet. From that slope, `empty_in_seconds` is
how long until usage would reach 100% at the current rate, null when the rate is unknown, zero, or
negative. When `empty_in_seconds` is shorter than the time actually left until the window's own
reset, the window's pace state becomes CONSERVE regardless of what the straight-line usage-so-far
rule alone would say -- a fast recent burn is the earlier warning, catching a burst before enough
time has passed for the straight-line comparison to reflect it. The grace period still holds this
projection off during the first 10% of a window, unless the projected empty-in is itself under 30
minutes: an opening burst that is about to run the window dry right away is not what grace exists
to protect. `pace_projection_conserve` records the transition once per window per hour, so a
sustained burst logs one event, not one per poll.

Example: a 5-hour window at 22% used with a 60%/hour burn over the last few reads projects
"empty in 48m" against a reset that's 3h 12m away -- CONSERVE, reason `burning 60%/h, empty in 48m,
reset in 3h 12m`, even though 22% used against straight-line pace alone would still read NORMAL.

## Sustainable pace

`sustainable_percent_per_hour` is `remaining_percent / hours_until_reset`: the constant rate that
would spend exactly what's left, right up to the reset, with nothing wasted and nothing run out
early. It's null with no reset time. `headroom`'s status line shows it beside the live burn once
burn is known, `burn 22%/h, ok 9%/h`, so a glance says whether the current rate is running hotter
or colder than the line that would land exactly on empty at reset.

## Learned costs

A lease can carry an `action_class` (set by `lease start --class` or by `can --lease`), and every
percent point a lease's meter spends while it's the active reservation is attributed to that class.
`headroom cost [<action-class>]` reports the median spent percent, its
interquartile range, and the sample count -- one sample per lease, whether it ended up spending
something or nothing. `can` uses this when the caller gives no `--expect`: it reports the learned
median as the expected cost, a sample-count confidence band (`none`/`low`/`medium`/`high`), and how
many more calls of that cost would fit in the deciding meter's remaining percent before reset.
`--lease` then reserves that expectation as a new lease under the same class, so the next `can` for
it has one more sample.

Two limits worth knowing. Vendor meters report whole percentage points, so a learned cost under a
couple of points is coarse by construction -- the median is real, but don't read false precision
into it. And attribution is an estimate, not a ledger entry: when several leases are active on the
same meter at once (several orchestrators, or several lanes under one orchestrator), a usage delta
is split across them by their expected share, not measured per-request -- exactly right when one
lease is the only one spending, an estimate with real uncertainty when several are running
concurrently. The confidence band exists because of this, not despite it.

## Cost model and local_preference

Every meter carries one of two cost models. Subscription meters are `sunk`: the capacity was
already paid for and expires unused at reset, so leaving it idle is a straight loss and a HARVEST
window is worth spending. Local pools are `marginal`: every request costs real energy on real
hardware, so Headroom never assumes idle local capacity should be used just because it's free of a
subscription limit. `local_preference` in `routing.toml` controls when local pools even get
considered: `fallback` (the default) offers them only once every subscription meter an action
consumes is CONSERVE or FREEZE, `prefer` offers them first for fungible work, `never` lists them
but never routes to them.

Example: with the default `fallback`, a `gemini-bulk` action stays on `antigravity:gemini` while
it's HARVEST or NORMAL, and only considers `gpu-box-vllm:capacity` once `antigravity:gemini` turns
CONSERVE.

## Consumes graph

An action class maps to the set of meters it draws from, in `routing.toml`'s `[consumes]` table.
`headroom can` and its MCP equivalent, `quota_can`, check every meter an action consumes and
refuse if any one of them can't afford it; a Fable call is blocked by a frozen `fable` meter even
if the account's overall `all` meter has room.

Example: `claude-fable = ["claude-main:all", "claude-main:fable"]` means a `claude-fable` action
needs both meters to allow it.

## Leases

A lease reserves a slice of a meter for one orchestrator before it fans out work, so a second
orchestrator asking `headroom can` at the same time sees that capacity as already spoken for
instead of double-booking it. A lease has an owner, a meter, an optional expected percent, a
time-to-live after which it expires on its own, and an end time once the orchestrator is done.
Passing `--owner` to `headroom can` excludes your own open leases from the reservation you're
checking against, so you don't get blocked by your own claim.

Example: `headroom lease start --owner triage-bot --meter codex-main:main --expect 15 --ttl 30m`
reserves 15 points of `codex-main:main` for 30 minutes.

## Plan line, gate and fill

`headroom plan --meter M --reserve N` splits the weekly window's remaining percent (after the
reserve) evenly across the whole 5h windows left before the weekly reset, and reports both that
per-window share and the "plan line" -- the weekly percent-per-hour that would spend the reserved
budget exactly by the reset. `headroom gate --need 5h:N [--need wk:N] --owner X` is the pre-dispatch
check a caller runs before every lane: it fails closed the same way `can` does, and with `--plan`
also requires a 5h request to fit under the plan line, not just under the reserve.

`policy.toml`'s `pacing` (`"even"`, the default, or `"none"`) controls two extra checks scoped to a
5h `--need` and one owner. The pro-rata line is that owner's planned share of the window (from
`--plan-share`, or their active leases plus the request) scaled by how much of the window has
elapsed; spending ahead of it by more than a small tolerance is refused even when the plain reserve
check would allow it. The burst check looks at the meter's own last-10-minutes burn independent of
any plan: more than twice the plan rate refuses with a reason naming when the line would catch up.
`pacing = "none"` skips both, leaving only the plain reserve/plan-line checks. `headroom fill --meter
M --until-reset [--lane-cost N] --owner X` answers "how many more lanes fit before this window's
unspent points are lost at reset": under even pacing it only offers the window's full remainder in
the last 45 minutes before reset, offering the pro-rata allowance instead any earlier than that. It
also lists, per `routing.toml` `[cost.<class>]` entry, how many runs of that class fit the window's
remaining points and remaining minutes (a learned median cost overrides the static config number
once samples exist).

Example: a burst of parallel lanes that jumps a 5h window from 1% to 23% in ten minutes trips the
burst check (well over twice a modest plan rate) even though 23% used is nowhere near the freeze
reserve -- `gate` refuses with `burst: 48 pts/h over the last 10 min, plan 4 pts/h; hold until 17:45`.

## Events

An event is a separate, append-only record of something that happened to a principal or meter: a
reset was seen, a free reset was granted or used, a plan changed, a source started failing or
recovered, a lease started or ended. Each event carries its origin, `vendor_reported` when the
vendor said so directly or `inferred` when Headroom deduced it (for example, from a large drop in
usage between polls), a confidence score, and the observation ids that back it up. Events are
never folded into observations; a percentage and the fact that explains it are two different kinds
of record.

Example: `codex-main` shows `reset seen 14:00 (inferred, 62%)` when usage drops sharply without a
vendor-confirmed reset timestamp yet.
