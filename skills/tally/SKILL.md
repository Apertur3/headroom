---
name: tally
description: Budget-aware orchestration with Tally. Use before spawning agents, dispatching bulk work, or choosing which subscription or local model runs a task. Tally answers what each account and meter can afford right now; it never decides which model is best for the task.
---

# Tally: know your budget before you spend it

Tally reports remaining capacity per meter (account × limit family), with reset times, pace
states and freshness. Capability routing stays yours, in `~/.tally/routing.toml`.

## The rule of order

1. **Pick by capability first.** Decide which pool is best for the task from your own routing
   table. Tally has no opinion on model quality and never will.
2. **Ask Tally if that pool can afford it.** `tally can <action-class>` returns YES or NO with the
   limiting meter and its pace state. Exit code 0 means yes, 2 means no.
3. **On NO, walk your fallback list** for that action class, in your order. Tally only filters
   the list by budget; it never reorders it by capability.
4. **Harvest only fungible work.** HARVEST means a meter is under its straight-line burn and the
   capacity expires at reset. Send bulk, mechanical or rubric-judged work there. Never move a
   hard review or an ambiguous judgment to a pool because it has credits.
5. **Local pools follow `local_preference`.** `fallback` (default): offered only when every
   eligible subscription pool is CONSERVE or FREEZE. `prefer`: local first for fungible work.
   `never`: shown, never suggested. Local inference costs energy; that is a user choice.
6. **FREEZE is the only hard rule.** Never spawn into a frozen meter. Everything else is advice
   you may override, and when you do, say why in the dispatch note so Tally's audit log has it.
7. **UNKNOWN is not capacity.** A stale or failed meter blocks `can` unless you pass
   `--allow-unknown` on purpose. Do not assume a failed read means room.
   A displayed `n/a` is different: the vendor confirms that window is not enforced, so Tally
   ignores it for `can` and thresholds.

## Commands

- `tally` : one line per meter with pace state and freshness.
- `tally can <action-class> [--allow-unknown]` : go / no-go for an action class.
- `tally --threshold 90` : exit 2 if any fresh window is at or above 90%.
- `tally events --since 24h` : resets seen, free resets granted or used, source failures.
- MCP tools `quota_status`, `quota_can`, `quota_events` expose the same from a daemon.

## Pace states

| State | Meaning | What to do |
|---|---|---|
| HARVEST | More than 10 points under straight-line burn | Send fungible work here before it expires |
| NORMAL | Within 10 points of the line | Proceed |
| CONSERVE | More than 10 points over the line | Hold non-essential work, prefer fallbacks |
| FREEZE | Past the freeze reserve | Do not spawn |
| UNKNOWN | Stale or failed reading | Treat as no capacity |

## Habits

- Check `tally` before any fan-out of more than two agents and after any 429 or limit error.
- Do not poll in a loop; one read per decision. Tally's daemon does the sampling.
- When the user fires a free reset, `tally events` shows it; refresh your plan then.
