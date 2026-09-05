# MCP and agents

Headroom's MCP server is a small stdio JSON-RPC 2.0 server (`headroom mcp`), with no external MCP
SDK dependency. It exposes six tools, defined in `src/mcp.ts`: three read status, three manage
leases. Every tool tries the daemon first, over its local socket or named pipe, and falls back to
a direct poll (marked `"source": "direct"` in the result) if no daemon is running.

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
(boolean, optional).

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
      ]
    }
  }
}
```

`owner` is required. It's how Headroom excludes your own open leases from the reservation check,
so calling `quota_can` doesn't get blocked by a lease you started yourself.

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

Arguments: `owner` (string, required), `meter_id` (string, required), `expected_percent` (number,
optional), `ttl_ms` (number, optional; the CLI's own default is 30 minutes), `note` (string,
optional).

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

Arguments: `id` (string, required), `owner` (string, required), `force` (boolean, optional).
Ending a lease with a different `owner` than the one that started it is refused unless `force` is
`true`.

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

## CLI equivalents

For agents that call a shell instead of MCP, such as Codex or Gemini CLI sessions:

| MCP tool | CLI equivalent |
|---|---|
| `quota_status` | `headroom [--json] [--principal <id>] [--threshold <n>]` |
| `quota_can` | `headroom can <action-class> --owner <name> [--allow-unknown] [--json]` |
| `quota_events` | `headroom events [--since 24h]` |
| `quota_lease_start` | `headroom lease start --owner <name> --meter <meter_id> [--expect <percent>] [--ttl 30m] [--note "..."]` |
| `quota_lease_end` | `headroom lease end <id> --owner <name> [--force]` |
| `quota_leases` | `headroom lease list` |
| `quota_route` | `headroom route --class <action-class> --owner <name> [--allow-unknown] [--json]` |

`headroom can` exits 0 for yes and 2 for no, in addition to printing a line, so a script can check
the exit code without parsing `--json`. `headroom lease end` exits 1 if `--owner` doesn't match
the lease and `--force` wasn't passed.
