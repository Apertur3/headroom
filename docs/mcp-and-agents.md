# MCP and agents

Headroom's MCP server is a small stdio JSON-RPC 2.0 server (`headroom mcp`), with no external MCP
SDK dependency. It exposes fourteen tools, defined in `src/mcp.ts`: three read status, three manage
leases, six pace a window, one routes an action class to an account, and one ingests a pasted
`/usage` panel. Every tool but `quota_wait`, `quota_route` and `quota_usage_paste` tries the daemon
first, over its local socket or named pipe, and falls back to
a direct poll (marked `"source": "direct"` in the result) if no daemon is running. `quota_wait`,
`quota_route` and `quota_usage_paste` always read directly, since none has a daemon RPC case at
all -- `quota_wait` because it never blocks (it just reports the reset time), `quota_route` because
it's a deliberate, occasional call, not a hot path worth a daemon round trip, and
`quota_usage_paste` because it is a rare, human-triggered write.

Every tool call is validated against its own declared schema before any dispatch, to the daemon or
to the direct fallback: an argument of the wrong type, a number outside the bounds noted below (the
same bounds the CLI's own flags enforce), or a name the tool never declared is refused with a JSON-
RPC invalid-params error naming the argument, rather than being coerced, dropped, or ignored. A
`needs` array (`quota_gate`) is rejected as a whole the moment one entry doesn't match `"5h:N"` /
`"wk:N"`, rather than silently checking only the valid entries.

## Status tools

### `quota_status`

No arguments. Returns the latest observation for every window of every meter Headroom knows
about.

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quota_status","arguments":{}}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "[{\"principal_id\":\"claude-main\", ...}]" }],
    "structuredContent": [
      {
        "principal_id": "claude-main",
        "meter_id": "claude-main:all",
        "window": { "kind": "rolling", "minutes": 300, "enforcement": "hard" },
        "quantity": { "used": 3, "limit": 100, "remaining": 97, "unit": "percent" },
        "resets_at": "2026-09-04T17:10:00.000Z",
        "freshness": "fresh",
        "truth": "official"
      }
    ]
  }
}
```

Behind a daemon, `structuredContent` is the raw observation array. Without one, it's
`{ "source": "direct", "observations": [...], "failures": [...] }`.

### `quota_can`

Arguments: `action_class` (string, required), `owner` (string, required), `allow_unknown`
(boolean, optional), `expect_percent` (number, optional, 0-100; overrides the learned cost for the
"max more before reset" figure), `lease` (boolean, optional; reserves the deciding meter for the
expected or learned percent, same as `can --lease`).

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"quota_can","arguments":{"action_class":"claude-fable","owner":"triage-bot"}}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{ "type": "text", "text": "{...}" }],
    "structuredContent": {
      "allowed": true,
      "meter": "claude-main:fable",
      "state": "NORMAL",
      "reason": "wk 42% NORMAL",
      "meters": [
        { "meter": "claude-main:all", "state": "HARVEST", "reason": "5h 3% HARVEST" },
        { "meter": "claude-main:fable", "state": "NORMAL", "reason": "wk 42% NORMAL" }
      ],
      "cost": {
        "action_class": "claude-fable",
        "expected_percent": 4.2,
        "source": "learned",
        "confidence": "medium",
        "sample_count": 6,
        "median_percent": 4.2,
        "iqr_low": 3.1,
        "iqr_high": 5.0,
        "max_more_before_reset": 23
      },
      "leased_id": null
    }
  }
}
```

`owner` is required. It's how Headroom excludes your own open leases from the reservation check,
so calling `quota_can` doesn't get blocked by a lease you started yourself. `cost` is always
present (its fields are `null` with no learned or given expectation yet); `leased_id` is the new
lease's id when `lease: true` was passed and the call was allowed, otherwise `null`.

### `quota_events`

Arguments: `since` (string, optional; an ISO timestamp the caller resolves itself, defaulting to
24 hours ago if omitted).

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"quota_events","arguments":{"since":"2026-09-03T00:00:00.000Z"}}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "[...]" }],
    "structuredContent": [
      {
        "id": "5f2c...",
        "kind": "reset_seen",
        "origin": "inferred",
        "confidence": 0.62,
        "meter_id": "codex-main:main",
        "principal_id": "codex-main",
        "created_at": "2026-09-03T14:00:00.000Z"
      }
    ]
  }
}
```

## Lease tools

### `quota_lease_start`

Arguments: `meter_id` (string, required), `owner` (string, optional; defaults to
`<client name>#<session id>` from the MCP session when omitted), `expected_percent` (number,
optional, 0-100), `ttl_ms` (number, optional, > 0; the CLI's own default is 30 minutes), `note`
(string, optional), `action_class` (string, optional; attributes the lease's spend to a class for
`quota_cost`, same as `lease start --class`).

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"quota_lease_start","arguments":{"owner":"triage-bot","meter_id":"codex-main:main","expected_percent":15,"ttl_ms":1800000}}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [{ "type": "text", "text": "{...}" }],
    "structuredContent": {
      "id": "a1b2c3d4",
      "owner": "triage-bot",
      "meter_id": "codex-main:main",
      "expected_percent": 15,
      "note": null,
      "started_at": "2026-09-04T12:00:00.000Z",
      "expires_at": "2026-09-04T12:30:00.000Z",
      "ended_at": null,
      "ended_reason": null,
      "spent_percent": 0
    }
  }
}
```

### `quota_lease_end`

Arguments: `id` (string, required), `owner` (string, required), `force` (boolean, optional),
`confirm_force` (boolean, optional), `reason` (string, optional). Ending a lease with a different
`owner` than the one that started it is refused unless `force` is `true`; setting `force` also
requires `confirm_force: true` plus a non-empty `reason`, both of which are audited.

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"quota_lease_end","arguments":{"id":"a1b2c3d4","owner":"triage-bot"}}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "content": [{ "type": "text", "text": "{...}" }],
    "structuredContent": {
      "id": "a1b2c3d4",
      "owner": "triage-bot",
      "meter_id": "codex-main:main",
      "ended_at": "2026-09-04T12:20:00.000Z",
      "ended_reason": "ended",
      "spent_percent": 4.2
    }
  }
}
```

### `quota_leases`

No arguments. Lists active and recently ended leases with their estimated spend.

```json
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"quota_leases","arguments":{}}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "content": [{ "type": "text", "text": "[...]" }],
    "structuredContent": [
      {
        "id": "a1b2c3d4",
        "owner": "triage-bot",
        "meter_id": "codex-main:main",
        "expected_percent": 15,
        "spent_percent": 4.2,
        "started_at": "2026-09-04T12:00:00.000Z",
        "expires_at": "2026-09-04T12:30:00.000Z",
        "ended_at": null
      }
    ]
  }
}
```

## Pacing and routing tools

Every one of these takes a `meter` id (for example `codex-main:main`) unless noted, and answers
from the same store the CLI uses. Percentages are whole vendor percents; times are ISO 8601.

### `quota_rate`

`meter`, optional `minutes` (default 30). Returns the burn in percent per hour over that period,
the sustainable pace to reach the reset with nothing to spare, and the projected time at which
the window would hit its limit at the current burn (`null` when the burn is zero or unknown).
CLI: `headroom rate --meter M`.

### `quota_plan`

`meter`, optional `reserve_percent` (0-100). Returns the weekly points available per remaining 5h
window before the weekly reset, and the plan line (linear budget) to hold. Fails UNKNOWN if the
weekly window's own reading is stale, failed, or older than `staleness_minutes`. CLI: `headroom
plan`.

### `quota_gate`

`needs` (array of `"5h:15"` / `"wk:3"` strings; rejected as a whole if any entry does not match
that shape), optional `meter`, `plan`, `reserve_percent` (0-100), `owner`, `plan_share_percent`
(>= 0), `action_class` (adds a `lanes_remaining_for_class` figure from the learned cost for that
class, when one exists). The pre-dispatch check: `fits: true` when the requested points fit
the current window (and, with `plan`, the plan line); under even pacing a 5h need is also checked
against the pro-rata share of the window that has elapsed, and a burst is refused with a reason.
Fails UNKNOWN, naming the meter, if a window the request actually consumes is stale, failed, or
older than `staleness_minutes`, or if `meter` resolves to several meters and one of them has never
produced a windowed reading at all. CLI: `headroom gate` (exit 2 when it does not fit).

### `quota_wait`

`meter`. Never blocks: returns the window's reset time and a suggested sleep in seconds so the
caller can wait itself. CLI: `headroom wait --until-reset` blocks for you.

### `quota_fill`

`meter`, optional `lane_cost_percent` (> 0), `weekly_reserve_percent` (0-100), `owner`,
`plan_share_percent` (>= 0). How many more lanes fit before the 5h window's unspent points are
lost at reset, and which `routing.toml` action classes still fit the remaining points and minutes.
Fails UNKNOWN if the tightest enforced window (or the weekly one, when both are enforced) is stale,
failed, or older than `staleness_minutes`. CLI: `headroom fill`.

### `quota_cost`

Optional `action_class`. The learned cost per action class from ENDED leases only (finished
normally, or expired): median spent percent, interquartile range and sample count. An in-progress
lease is never counted -- it has no observed spend yet. CLI: `headroom cost`.

### `quota_spend`

Optional `meter`, `owner`, `since` (an ISO timestamp, defaulting to 24 hours ago). Per-owner
attributed spend from the spend ledger: for each meter and window, how much of the movement over
that period Headroom books to each lease owner, with `confidence` and the number of deltas behind
it. The owner `unattributed` is real movement that happened while no lease was open. Take a lease
per lane if you want your own spend to be attributable. CLI: `headroom spend`.

### `quota_inbox`

`session` (required), optional `since` (milliseconds since the epoch). Reads that session's
hand-off messages from `<HEADROOM_HOME>/inbox/<session>/`, oldest first, and marks each read by
renaming it -- so a hand-off is acted on once. Each message carries `kind` (`budget`, `note`, or
`handoff`), `from`, `at`, and `body`. A backlog over 200 messages returns the first 200 and
reports the rest as `remaining`. Read-only on purpose: sending is `headroom inbox send`, never a
tool call, so nothing can fabricate a hand-off from a session that did not make one. CLI:
`headroom inbox --session <id>`.

### `quota_route`

`action_class`, `owner`, optional `allow_unknown`. Among the principals the routing entry for
that action class allows, picks the one with the most remaining headroom on its own tightest
window, and returns its launch environment (for example `CLAUDE_CONFIG_DIR`). `owner` reserves
every OTHER owner's active lease against these same meters before scoring and ranking each
candidate, the same reservation `quota_can` applies. `null` when none fits; UNKNOWN rows never win
unless `allow_unknown` is set. CLI: `headroom route`.

### `quota_usage_paste`

`text` (the pasted `/usage` panel), optional `principal` (required when more than one Claude
principal is configured). Parses the panel's session line, all-models week and any model-scoped
week, and stores each as an observation on `<principal>:all` or `<principal>:<model-slug>` with
`source: "paste"`, `truth: "official"` and confidence 0.9. Use it when a meter cannot be polled at
all, or when a human can see a scoped bar the account-wide window hides. Returns the stored
observations plus `unparsed`, the panel lines it could not place. The next successful poll
supersedes these rows by being newer. CLI: `headroom usage --paste`.

## How an orchestrator should use them

This mirrors `skills/headroom/SKILL.md`, which any Claude Code session with the skill installed
already follows:

1. Pick the pool by capability first, from your own routing table. Headroom has no opinion on
   which model is good at what, and never will.
2. Ask `quota_can` (or `headroom can`) whether that pool can afford the action, passing your own
   `owner` name. `allowed: true` means go; `allowed: false` means walk your own fallback list for
   that action class, in your own order. Headroom only filters that list by budget; it never
   reorders it by capability.
3. Before fanning out more than a couple of agents, and after any 429 or vendor limit error, call
   `quota_status` (or `headroom`) once to refresh your picture. Don't poll in a loop; the daemon
   already owns the sampling.
4. Send fungible, mechanical, or rubric-judged work to a HARVEST meter before it expires at reset.
   Never move a hard review or an ambiguous judgment there just because it has spare capacity.
5. Treat FREEZE as a hard rule: never spawn into it. Everything else, including a CONSERVE meter
   or a declined local pool, is advice you can override, but log why in the lease note or dispatch
   record when you do.
6. Treat UNKNOWN as no capacity. Only pass `allow_unknown: true` on purpose, never as a default.
7. Take a lease (`quota_lease_start`) before fanning out a batch of work against a meter, and end
   it (`quota_lease_end`) when the batch finishes, so other orchestrators on the same machine see
   the reservation instead of racing it.
8. On a shared account, take one lease per lane so the ledger can attribute what the meter
   actually moves to you, and read `quota_spend` with your own `owner` at each window boundary to
   see what your share really cost. Leave anything another session has to act on in its inbox
   rather than in a lease note, and read your own with `quota_inbox` before you plan the next
   window.

## CLI equivalents

For agents that call a shell instead of MCP, such as Codex or Gemini CLI sessions:

| MCP tool | CLI equivalent |
|---|---|
| `quota_status` | `headroom [--json] [--principal <id>] [--threshold <n>]` |
| `quota_can` | `headroom can <action-class> --owner <name> [--allow-unknown] [--json]` |
| `quota_events` | `headroom events [--since 24h]` |
| `quota_lease_start` | `headroom lease start --owner <name> --meter <meter_id> [--expect <percent>] [--ttl 30m] [--note "..."] [--class <action-class>]` |
| `quota_lease_end` | `headroom lease end <id> --owner <name> [--force]` |
| `quota_leases` | `headroom lease list` |
| `quota_route` | `headroom route --class <action-class> --owner <name> [--allow-unknown] [--json]` |
| `quota_rate` | `headroom rate [--meter <meter_id>] [--owner <name>] [--minutes 30] [--json]` |
| `quota_plan` | `headroom plan --meter <meter_id> --until reset [--reserve <percent>] [--json]` |
| `quota_gate` | `headroom gate --need 5h:<n> [--need wk:<n>] (--meter <meter_id> \| --class <action-class> \| --model <slug>) --owner <name> [--plan] [--plan-share <n>] [--json]` (exit 2 when it does not fit) |
| `quota_wait` | `headroom wait --meter <meter_id> --until-reset [--max 6h]` (exit 3 on `--max`) |
| `quota_fill` | `headroom fill --meter <meter_id> --until-reset [--lane-cost <percent>] [--weekly-reserve <percent>] [--plan-share <n>] --owner <name> [--json]` |
| `quota_cost` | `headroom cost [<action-class>] [--json]` |
| `quota_spend` | `headroom spend [--meter <meter_id>] [--owner <name>] [--since 24h] [--json]` |
| `quota_inbox` | `headroom inbox --session <session-id> [--since <epoch-ms>] [--json]` (send: `headroom inbox send --to <session-id> --kind <budget\|note\|handoff> (--file <path> \| --text <text>)`) |
| `quota_usage_paste` | `headroom usage --paste [--principal <id>] [--json]` (or `--clipboard`) |

`headroom can` exits 0 for yes and 2 for no, in addition to printing a line, so a script can check
the exit code without parsing `--json`. `headroom lease end` exits 1 if `--owner` doesn't match
the lease and `--force` wasn't passed.
