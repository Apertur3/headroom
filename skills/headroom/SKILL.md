---
name: headroom
description: Budget-aware orchestration with Headroom. Use before spawning agents, dispatching bulk work, or choosing which subscription or local model runs a task. Headroom answers what each account and meter can afford right now; it never decides which model is best for the task.
---

# Headroom: know your budget before you spend it

Headroom reports remaining capacity per meter (account × limit family), with reset times, pace
states and freshness. Capability routing stays yours, in `~/.headroom/routing.toml`.

## The rule of order

1. **Pick by capability first.** Decide which pool is best for the task from your own routing
   table. Headroom has no opinion on model quality and never will.
2. **Ask Headroom if that pool can afford it.** `headroom can <action-class>` returns YES or NO with the
   limiting meter and its pace state. Exit code 0 means yes, 2 means no.
3. **On NO, walk your fallback list** for that action class, in your order. Headroom only filters
   the list by budget; it never reorders it by capability.
4. **Harvest only fungible work.** HARVEST means a meter is under its straight-line burn and the
   capacity expires at reset. Send bulk, mechanical or rubric-judged work there. Never move a
   hard review or an ambiguous judgment to a pool because it has credits.
5. **Local pools follow `local_preference`.** `fallback` (default): offered only when every
   eligible subscription pool is CONSERVE or FREEZE. `prefer`: local first for fungible work.
   `never`: shown, never suggested. Local inference costs energy; that is a user choice.
6. **FREEZE is the only hard rule.** Never spawn into a frozen meter. Everything else is advice
   you may override, and when you do, say why in the dispatch note so Headroom's audit log has it.
7. **UNKNOWN is not capacity.** A stale or failed meter blocks `can` unless you pass
   `--allow-unknown` on purpose. Do not assume a failed read means room.
   A displayed `n/a` is different: the vendor confirms that window is not enforced, so Headroom
   ignores it for `can` and thresholds.

## Commands

- `headroom` : one line per meter with pace state and freshness.
- `headroom can <action-class> [--allow-unknown] [--expect <percent>] [--lease]` : go / no-go for an action class.
- `headroom --threshold 90` : exit 2 if any fresh window is at or above 90%.
- `headroom events --since 24h` : resets seen, free resets granted or used, source failures.
- `headroom cost [<action-class>]` : learned median/IQR/sample-count spent percent per class.
- `headroom rate [--meter M] [--minutes 30]` : burn over a recent window and ETA to the limit.
- `headroom plan --meter M --until reset --reserve N` : points per remaining 5h window and the plan line.
- `headroom gate --need 5h:N [--need wk:N] [--plan] --owner X` : pre-dispatch check before a lane.
- `headroom wait --meter M --until-reset [--max 6h]` : block until a window resets.
- `headroom fill --meter M --until-reset [--lane-cost N] --owner X` : lanes and action classes that fit before the window's unspent points are lost at reset.
- MCP tools `quota_status`, `quota_can`, `quota_events`, `quota_cost`, `quota_rate`, `quota_plan`, `quota_gate`, `quota_wait`, `quota_fill` expose the same from a daemon (`quota_wait` never blocks: it returns the reset time and a suggested sleep).

## Leases

Take a lease before fanning out work: `headroom lease start --owner <name> --meter <meter_id> --expect <percent> [--class <action-class>]`. Pass `--owner <name>` to `headroom can` so your own reservation is not counted twice, and end the lease when the work is done. Other orchestrators on this machine see active leases.

## Pacing

- **Check burn before fan-out.** `headroom rate --meter M` (or the pace segment on `headroom`'s own status line, `burn 22%/h, ok 9%/h`) says whether the current rate would empty the window before its reset. A fast burn flips a window's pace state to CONSERVE even when the straight-line usage-so-far still looks fine -- that projection is the earlier warning, not a false alarm.
- **`can --lease` so costs are learned.** With no `--expect`, `can` reports the learned median cost for the action class (or "unknown" the first time) plus how many more calls fit before reset at the sustainable pace. Passing `--lease` reserves the deciding meter for that expectation, so the next `can` for the same class has one more sample to learn from -- `headroom cost <action-class>` shows the running median, IQR and sample count.
- **A projection CONSERVE is slow down, not stop.** It means the current rate would run the window dry early, not that the window is out of room. Prefer fungible or lower-priority work over new fan-out until the rate settles; FREEZE, not CONSERVE, is the hard stop.
- **`gate` before every lane, `fill` before a window ends with slack.** `gate --need 5h:N --owner X` is the per-lane pre-dispatch check; under the default `pacing = "even"` it also refuses a burst that runs far ahead of your planned share for this window, even if the raw reserve isn't crossed yet. `fill` answers "how many more lanes (and which routing.toml action classes) fit before this window's unspent points are lost at reset" -- ask it as a window's reset approaches with slack still on the table, rather than guessing whether one more lane is safe.

## Pace states

| State | Meaning | What to do |
|---|---|---|
| HARVEST | More than 10 points under straight-line burn | Send fungible work here before it expires |
| NORMAL | Within 10 points of the line | Proceed |
| CONSERVE | More than 10 points over the line | Hold non-essential work, prefer fallbacks |
| FREEZE | Past the freeze reserve | Do not spawn |
| UNKNOWN | Stale or failed reading | Treat as no capacity |

## Habits

- Check `headroom` before any fan-out of more than two agents and after any 429 or limit error.
- Do not poll in a loop; one read per decision. Headroom's daemon does the sampling.
- When the user fires a free reset, `headroom events` shows it; refresh your plan then.
