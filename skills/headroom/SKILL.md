---
name: headroom
description: Budget-aware orchestration with Headroom. Use before spawning agents, dispatching bulk work, or choosing which subscription or local model runs a task. Headroom answers what each account and meter can afford right now; it never decides which model is best for the task.
---

# Headroom: know your budget before you spend it

Headroom reports remaining capacity per meter (account × limit family), with reset times, pace
states and freshness. Capability routing stays yours, in `~/.headroom/routing.toml`.

## Setting Headroom up

When the user asks to set up, install or configure Headroom, run these in order and stop at the
first one that fails, showing its output:

1. `headroom version`; if the command is missing, `npm install -g headroomd` (Node 22.13 or newer).
   If the user agrees, run `headroom setup --yes --skip-mcp` to do accounts discovery, doctor and
   the background service install in one pass -- it answers yes to each of those on its own and
   shows its output.
2. Register the MCP server in the agent that will use it, for example
   `claude mcp add --scope user headroom -- headroom mcp`, and confirm with a `quota_status` call.
3. `headroom doctor` once more; every non-OK line names the next command.
4. Show `headroom --json` or `headroom --agent` once and explain the pace state on each row.

## Keep the budget in sight

When the user works in Claude Code, offer to put Headroom in its status bar: set
`"statusLine": { "type": "command", "command": "headroom statusline --render" }` in
`~/.claude/settings.json` (or `<CLAUDE_CONFIG_DIR>/settings.json` for another profile), adding
`--chain '<their existing command>'` after `--render` when they already have one. That single line
shows this session's own 5h and weekly percentages exactly as Claude Code reported them, plus every
other principal, model-scoped meter, pace state, active lease and reserve from Headroom's own view.
It is a read of the store, never a vendor call, and it is capped at 150 ms so it cannot slow a
prompt down; the non-session figures on it can be one poll interval old, so keep deciding from
`can`, `gate` and `route` rather than from what the bar happened to show.

## Scoped models gate on their own meter

A vendor can cap one model separately from the account (Claude's Fable and Routines buckets are
`<principal>:fable` and `<principal>:routines`). A YES from `gate` or `can` on `<principal>:all`
says nothing about those. Before dispatching a scoped model, gate on its meter: `headroom gate
--model fable --need wk:5 --owner <name>` (or `--meter <principal>:fable`). When that meter reads
UNKNOWN the answer is no, not "use the account figure". `headroom --models` is a local token-share
estimate from session logs, never the vendor meter; do not gate on it.
When a scoped meter cannot be polled at all, ask the user to run `/usage` in Claude Code and paste
the panel into `headroom usage --paste` (or `quota_usage_paste`); that turns the bar they can see
into a real reading instead of dispatching blind.

## The rule of order

1. **Pick by capability first.** Decide which pool is best for the task from your own routing
   table. Headroom has no opinion on model quality and never will.
2. **Ask Headroom if that pool can afford it.** `headroom can <action-class>` returns YES or NO with the
   limiting meter and its pace state. Exit code 0 means yes, 2 means no.
   Dispatch through `headroom run` so the gate and lease bracket the launched lane, or call
   `quota_gate` and `quota_lease_start` yourself over MCP. Never launch a lane on a meter you have
   not gated.
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
7. **Protect your own meter.** Set a reserve on the meter your orchestrator itself runs on
   (`policy.toml`'s `[reserve]` table, e.g. `"claude-main:fable" = 10`), so the lanes you dispatch
   cannot spend the last of the budget you need to keep supervising them. A refusal whose reason
   names the reserve means stop dispatching that model, not retry with fewer points.
8. **UNKNOWN is not capacity.** A stale or failed meter blocks `can` unless you pass
   `--allow-unknown` on purpose. Do not assume a failed read means room.
   A displayed `n/a` is different: the vendor confirms that window is not enforced, so Headroom
   ignores it for `can` and thresholds.
   An UNKNOWN window may still show `last_known` (the newest fresh reading of that meter from the
   last 7 days, with its age) so you can see the trend behind it -- read that as history, never as
   a green light: `can`/`gate`/`route` already ignore it and answer NO the same as if it weren't there.
9. **A plan downgrade notice is a hard stop.** Stop all work on that vendor and tell the
   human. Do not use a reset credit. Dispatches stay refused until the human either restores
   the paid plan or explicitly runs `headroom ack plan <principal>` for an intended downgrade.

## Commands

- `headroom` : the current meters with pace state and freshness, grouped by principal for a person at a terminal and one dense line per meter in a pipe.
- Agents read `headroom --json` or `headroom --agent`, never the human view: `--json` is the contract, `--agent` is the dense one-line-per-meter fallback for a plain shell call, and the grouped `--human` view exists for people.
- `headroom can <action-class> [--allow-unknown] [--expect <percent>] [--lease]` : go / no-go for an action class.
- `headroom --threshold 90` : exit 2 if any fresh window is at or above 90%.
- `headroom events --since 24h` : resets seen, free resets granted or used, source failures.
- `headroom cost [<action-class>]` : learned median/IQR/sample-count spent percent per class.
- `headroom rate [--meter M] [--owner X] [--minutes 30]` : burn over a recent window and ETA to the limit, plus X's attributed share of it.
- `headroom spend [--meter M] [--owner X] [--since 24h]` : per-owner attributed spend on a shared meter.
- `headroom inbox --session <id>` / `headroom inbox send --to <id> --kind <budget|note|handoff> --text ...` : hand-offs between orchestrators.
- `headroom plan --meter M --until reset --reserve N [--target <points>]` : points per remaining 5h window, banked-reset advice and the plan line. Ask `quota_plan` with `target_points` before recommending a banked reset.
- `headroom credits set --principal <name> --available <n> --expires <date>` : record a banked reset only when the human says one exists; never infer it. A date-only expiry is midnight UTC on that date. Never fire a reset yourself -- that is a human action in the vendor UI.
- `headroom plan import <file>` : load a budget plan's per-session shares as advisory leases.
- `headroom gate --need 5h:N [--need wk:N] [--plan] [--allowance pro_rata|fill] --owner X` : pre-dispatch check before a lane.
- `headroom wait --meter M --until-reset [--max 6h]` : block until a window resets.
- `headroom fill --meter M --until-reset [--lane-cost N] [--allowance pro_rata|fill] --owner X` : capacity for queued lanes and action classes before the window resets.
- `headroom heartbeat --owner <name> --every <duration> [--resume "<sentence>"]` : record or refresh your own heartbeat with the daemon (`--stop` to deregister; `heartbeat list` to see every registered one).
- `headroom timer set --owner <name> --name <id> --at <ISO|+duration> --action "<text>"` : a named wake-up the daemon delivers, once, to your inbox when due (`timer list` / `timer clear --owner <name> --name <id>`).
- MCP tools `quota_status`, `quota_can`, `quota_events`, `quota_lease_start`, `quota_lease_end`, `quota_leases`, `quota_cost`, `quota_rate`, `quota_spend`, `quota_inbox`, `quota_plan`, `quota_gate`, `quota_wait`, `quota_fill`, `quota_usage_paste`, `quota_route`, and `quota_heartbeat` expose the same (`quota_wait` never blocks: it returns the reset time and a suggested sleep; named wake-ups are CLI-only, no MCP tool).

When a lane waits for a reset or build, keep it in one blocking call instead of ending turns to
poll: each turn-end wakes the orchestrator and resends its context. Use
`headroom wait --meter M --until-reset --max 6h` for a reset. For a long build, run one shell
loop such as `until [ -f build.done ]; do sleep 30; done`. `quota_wait` never blocks: it returns
`suggested_sleep_seconds`, capped at 3600 and null when the reset time is unknown. An MCP-only lane
should sleep that long in one blocking call, then call `quota_wait` again to re-check; if it is
null, re-check on a sensible interval.

Credit/count meters are informational, not dispatch capacity: never name one in routing or pass
one to `can`, `route`, or `gate`. `quota_plan` treats only a manual entry or a fresh, unheld vendor
count explicitly marked as reset availability as banked; a prepaid balance is not a reset credit.

## Leases

Take a lease before fanning out work: `headroom lease start --owner <name> --meter <meter_id> --expect <percent> [--class <action-class>]`. Pass `--owner <name>` to `headroom can` (and to `headroom route --class <action-class> --owner <name>`, which reserves the same way) so your own reservation is not counted twice, and end the lease when the work is done. Other orchestrators on this machine see active leases.

## Sharing one account with other orchestrators

Take a lease per lane, not one per session: the spend ledger books each poll's actual meter
movement to whoever held a lease at that moment, so a lane you did not lease spends under
`unattributed` and disappears from your own numbers. Read `headroom spend --owner <self>` (MCP
`quota_spend`) at every window boundary, and `headroom rate --owner <self>` mid-window, to see
what your share of the shared meter really cost rather than what you expected it to. A confidence
below 1 means other owners overlapped yours and the split is proportional to declared `--expect`
values, so declaring one makes your own figure sharper. When a human hands you an agreed division
of a window, `headroom plan import <file>` turns it into advisory leases the other sessions' gates
already respect. Leave anything another session must act on in its inbox (`headroom inbox send
--to <session> --kind handoff --text ...`) and read your own with `headroom inbox --session <self>`
before planning the next window; reading marks a message read, so a hand-off is acted on once.

## Host guard

`can` and `gate` (CLI and MCP) carry an additive `host` object -- `{ state: "ok" | "warn" |
"refuse" | "unknown", reasons, load_ratio, pty_used, pty_max, orphans }` -- alongside the quota
decision: local CPU load, pseudo-terminal usage and leaked-process count on the machine you're
about to fan out onto. Neither `can` nor `gate` ever refuses over it themselves; read `host.state`
before dispatching more LOCAL work anyway (spawning several agent lanes onto an already-overloaded
host is exactly how this repo's own P0 incident started -- see docs/concepts.md's "Host guard"
section). Only `headroom run`, which actually launches a child process, refuses on its own
(`state: "refuse"`, exit 2) when `policy.toml`'s `host_guard.mode = "refuse"` (the default);
`"warn"` or `"off"` still launches. `host.state: "unknown"` (a probe unsupported on this platform,
or one that failed) is never a reason to hold back -- treat it like any other unknown: no signal
either way, not a red flag.

## Heartbeats and named wake-ups

A crashed orchestrator session takes every in-session timer and watcher down with it, unnoticed
for as long as nobody happens to look. Beat once per interval so the daemon -- the one process
that survives that crash -- can tell "quiet because idle" from "quiet because gone": `headroom
heartbeat --owner <self> --every 5m --resume "<what a fresh session should do next>"` at the start
of a session and again on your own cadence, keeping the resume sentence current as the plan
changes. Miss more than 2x that interval and the daemon records `heartbeat_lapsed`, delivered to
the human the same way any other notification is; beating again closes it. Stop it explicitly
(`--stop`) when the session ends normally -- an unstopped heartbeat left lapsed is a false alarm
for whoever reads it next.

For a wake-up at a specific time rather than a recurring beat, `headroom timer set --owner <self>
--name <id> --at <ISO|+duration> --action "<text>"` delivers that text to your inbox once, when
due -- Headroom never executes it, only delivers it. Add `--if-missed notify` (the default) when a
human should also be told if you are not there to read it.

## Pacing

- **Check burn before fan-out.** `headroom rate --meter M` (or the pace segment on `headroom`'s own status line, `burn 22%/h, ok 9%/h`) says whether the current rate would empty the window before its reset. A fast burn flips a window's pace state to CONSERVE even when the straight-line usage-so-far still looks fine -- that projection is the earlier warning, not a false alarm.
- **`can --lease` so costs are learned.** With no `--expect`, `can` reports the learned median cost for the action class (or "unknown" the first time) plus how many more calls fit before reset at the sustainable pace. Passing `--lease` reserves the deciding meter for that expectation, so the next `can` for the same class has one more sample to learn from -- `headroom cost <action-class>` shows the running median, IQR and sample count.
- **A projection CONSERVE is slow down, not stop.** It means the current rate would run the window dry early, not that the window is out of room. Prefer fungible or lower-priority work over new fan-out until the rate settles; FREEZE, not CONSERVE, is the hard stop.
- **`gate` before every lane, `fill` for queued work near reset.** `gate --need 5h:N --owner X` is the per-lane pre-dispatch check; under the default `pacing = "even"` it also refuses a burst that runs far ahead of your planned share for this window, even if the raw reserve isn't crossed yet. `fill` reports how many more queued lanes (and which `routing.toml` action classes) fit before reset -- ask it when pending work needs a capacity check, rather than guessing whether one more lane is safe. Pass `allowance: "fill"` (or `--allowance fill`) only when that queued work should use the window before reset and no other work needs it; it projects open leases and recent burn to the lane end while retaining the cap. Unspent quota is information, not a target: never invent work to use it. Keep the pro-rata default otherwise.
- **An unscheduled reset means capacity appeared -- re-plan, and tell the human.** `gate`, `plan` and `fill` all carry a `notices` array for 24 hours after a reset that fired before its own scheduled instant (`headroom events`/`quota_events` show it as `reset_seen` with `metadata.unscheduled: true`): `"unscheduled reset on <meter> at <time>; capacity appeared, re-plan"`. Treat it exactly like a free reset -- new budget you did not plan for -- not like the scheduled weekly/5h boundary you already budgeted around; drop whatever conserve-mode assumptions were in effect for that meter and say so to the human, since it changes their own planning too.

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
- Read `can`/`gate`'s `host.state` before fanning out more LOCAL work, not just the quota decision.
- Do not poll in a loop; one read per decision. Headroom's daemon does the sampling.
- When the user fires a free reset, `headroom events` shows it; refresh your plan then.
