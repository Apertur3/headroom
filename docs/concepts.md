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
