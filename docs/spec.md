# Headroom spec v0.2 (2026-09-03)

Brand Headroom. Package `headroomd`, repo `https://github.com/Apertur3/headroom`, command `headroom`.

## Problem

Anyone running agents across several AI subscriptions needs three answers at decision time:
how much capacity is left per account and meter, when it comes back, and what to do about it.
Existing tools (CodexBar, ccusage, claude-monitor, agentburn) answer only the first, as desktop
apps or single-account CLIs. Headroom owns the second and third and keeps the first pluggable.

## Non-goals

- Not a menu-bar meter (CodexBar owns that; Headroom builds on it and aims for its ecosystem list).
- Not a proxy or load balancer. Headroom never sits in the request path.
- Not a capability router. Which model is good at what is the user's opinion in `routing.toml`.
- No hosted dashboard, TCP listener, or telemetry. Human views use cached local readings.

## Concepts

| Term | Meaning |
|---|---|
| Principal | One credential location: `{vendor, location}`. Claude = a config dir, Codex = a `CODEX_HOME`, Antigravity = the Google login behind `agy`, local = a base URL. Stable id, e.g. `claude-main`. |
| Meter | One vendor-enforced limit on a principal, stable id `principal:meter`. Claude Max: `all`, `fable`, `routines`. Antigravity: `gemini`, `claude-gpt`. Codex: `main`, `spark`, `credits`. Local: `capacity`. |
| Window | A bucket inside a meter: `kind = rolling | fixed | count`, `minutes`, `enforcement = hard | soft`. Credit counts have no duration and are informational. A count meter cannot be used in a consumes entry: `can`, `route`, and `gate` refuse it even with `--allow-unknown`. |
| Observation | One sample of one window: typed quantity (`used`, `limit`, `remaining`, `unit = percent | tokens | requests | credits`), nullable `resets_at`, `observed_at` (vendor time if given) and `fetched_at`, `source`, `truth = official | estimated`, `freshness = fresh | stale | failed | not_enforced`, `confidence 0..1`, `adapter_version`, `upstream_schema_version`. `not_enforced` is a vendor-confirmed absent cap (printed `n/a`), not an unknown read. Never a whole "reading" with mixed provenance; each datum carries its own. |
| Consumes | An action class maps to the set of meters it draws from. A Fable call on `claude-main` consumes `claude-main:all` and `claude-main:fable`. `headroom can` checks every consumed meter; one frozen meter freezes the action. |
| Event | Separate record with id, kind (`reset_seen`, `free_reset_granted`, `free_reset_used`, `credits_changed`, `plan_changed`, `source_failed`, `source_recovered`), `origin = vendor_reported | inferred`, `confidence`, evidence (observation ids), and later corrections. Never embedded in observations. |
| Pace state | Per window: HARVEST (>10 pts under straight-line burn), NORMAL, CONSERVE (>10 pts over), FREEZE (past freeze reserve, overrides all), UNKNOWN (stale or failed).. |
| Cost model | `sunk` (subscriptions, capacity expires at reset) or `marginal` (local inference, energy per hour). |

## Fail-closed semantics

Unknown is never capacity. A stale or failed window is `UNKNOWN`, printed as such on every
surface, and `headroom can` answers NO for it unless `--allow-unknown` is passed. Staleness
threshold per meter, default 15 minutes. Inferred events carry confidence and are labelled
inferred; a drop from 82% to 7% during backoff is `reset_seen` with low confidence, not a fact.
Vendor-confirmed `not_enforced` windows are ignored by `can` and `--threshold`; they are not
reported as `UNKNOWN` because there is no vendor-enforced capacity to fail closed over.
Informational count meters are also never capacity, but unlike a confirmed absent limit they are an
invalid dispatch target: `can`, `route`, and `gate` refuse them rather than silently ignoring them.
CLI and MCP clients re-enrich an unmarked status array from an older daemon using the current
policy and local store before they show it or make a threshold decision, so compatibility with a
running daemon cannot serve an expired stored-fresh row as capacity.

## Host guard

Quota is not the only reason a local dispatch can be a bad idea: `headroom run` also refuses to
launch its child process onto a host that cannot take it (see docs/concepts.md's "Host guard"
section for the full measurement/threshold reference and the 2026-09-27 PTY-leak incident that
motivated it). `policy.toml`'s `[host_guard]`: `mode = "refuse"` (default) `| "warn" | "off"`,
`warn_load_ratio` (2), `refuse_load_ratio` (3), `warn_pty_percent` (50), `refuse_pty_percent` (75).
`headroom run --json` exits `2` when host pressure refuses the launch (`host.state: "refuse"` and
`mode: "refuse"`), before the quota gate or any lease -- see docs/json-contract.md's `run` entry.
`can`/`gate` (CLI and MCP) carry the same reading additively and never refuse over it; only `run`
does.

## Architecture

```
headroom CLI ──┐                     ┌── engine: headroom-engine (Swift, links CodexBarCore pinned to a tag; Keychain enabled; emits observations)
headroom MCP ──┼─ Unix socket ─ daemon ┼── fallback engine: upstream CodexBarCLI binary (pinned, SHA-256) via schema adapter
statusline ─┘        │            ├── native:local adapter (OpenAI-compatible /v1/models, vLLM /metrics, llama.cpp /health)
                     ├── store: SQLite under ~/.headroom/ (observations, events, audit), 0600, canonicalized paths
                     ├── scheduler: per-principal interval, jitter, coalescing, exponential backoff on 401/403/429
                     └── policy: pace states, consumes graph, routing filter, thresholds
```

- **Engine (primary).** `CodexBarCore` is an MIT SwiftPM library building on macOS 14+ and
  Linux. `engine/` holds `headroom-engine`, a thin Swift CLI that depends on it at a pinned tag,
  enables Keychain reads for every Claude config dir (the upstream CLI disables them), loops over
  principals in-process, and prints observations in Headroom's schema. The npm artifact carries
  a universal macOS reader and its SHA-256 record; runtime verifies it before use. Linux and
  Windows do not ship this reader. Updating = bump the tag, rebuild,
  run conformance fixtures. Upstream drift breaks a test, not a user.
- **Engine (fallback).** The runner for the upstream CodexBarCLI stays as a fallback and as
  the conformance oracle.
- **Antigravity.** `agy` has no server mode but bootstraps its local HTTPS server when started
  under a pseudo-terminal (`script -q /dev/null agy`), verified 2026-09-03 with real numbers.
  The daemon warms its owned `agy` at startup. Consumer quotas come only from
  its local summary, using the packaged macOS native reader. Gemini CLI discovery and polling
  are retired; legacy configuration returns UNKNOWN with migration guidance.
- **Local pools.** `kind = "local"` principals with `base_url`, optional `wake` command that Headroom
  reports and never runs. State `UP | BUSY | DOWN`, model id, vLLM queue depth.
- **Registry.** `~/.headroom/accounts.toml`, auto-discovered from `~/.claude*`, `~/.codex*`,
  `~/.gemini`, confirmed by the user. Committed example in `examples/`.

### `accounts.toml` principal keys

Every `[[accounts]]` block has `name` and either provider `vendor`, `location`, and `adapter`, or
local `kind = "local"`, `base_url`, and `adapter = "native"`. Provider blocks may also set
`agy_path` and `alias`; local blocks may set `wake`. `enabled` is optional on both shapes: absent
means enabled, while `enabled = false` keeps the principal configured but prevents every poll and
current-capacity decision. `headroom accounts disable <name>` and `headroom accounts enable <name>`
edit only that line in place. Status renders a parked principal as
`<name>  disabled (enabled = false in accounts.toml)` instead of its meter rows.
- **Daemon.** Unix socket `~/.headroom/headroom.sock` on macOS and Linux, or named pipe
  `\\.\pipe\headroom-<username>-<home digest>` on Windows, JSON-RPC. POSIX sockets are mode 0600; Windows
  named pipes use the current process token's default DACL, which Node does not expose for further
  restriction. `headroom install-service` writes a launchd agent, systemd user unit, or Task Scheduler
  XML. Without a daemon the CLI and MCP server do a direct read and mark the result `source: "direct"`.

## Security (see SECURITY.md; additions from review)

- Same-UID code (npm packages, editor extensions, other agents) is inside the trust boundary of
  a 0600 socket. Mitigation: request coalescing and per-principal poll rate limits so no caller
  can force credential-backed polls or trigger vendor defenses; audit log records callers.
- Canonicalize and `lstat` every path under `~/.headroom/`, config dirs and credential files;
  reject symlinks and unsafe parent ownership or mode before use.
- Engine runs with a minimal environment (only the variables it needs), bounded stderr capture,
  allowlist logging; canary-secret tests assert no leakage through stderr, exceptions or JSON.
- Checksum proves reproducibility, not trust: pins are bumped only by an explicit human update;
  release attestations verified when upstream provides them.
- No TCP listener in v1. Removed until a real need exists.

## Surfaces

- `headroom dashboard` (alias `top`): cached terminal overview with per-meter usage bars,
  reset countdowns, selected-meter remaining-capacity charts, and optional diagnostics.
- `headroom dashboard --html <path>`: standalone local browser snapshot with subscription
  overview, meter/window selection and recorded-history charts. No external requests.
  Existing output is preserved unless `--force` is explicit.
- Both chart views use recorded observations only. Reset periods tolerate up to 60 seconds
  of vendor timestamp jitter; resets, usage drops, gaps and untrusted readings break lines.

- `headroom` : one line per meter, freshness always visible:
  `claude-main:all  5h 3% ↻17:10 HARVEST | wk 61% ↻Sat 14:00 CONSERVE  (fresh 2m)`
- `headroom --json`, `--principal X`, `--threshold N` (exit 2 if any enforced window is stale,
  failed, or ≥ N),
  `headroom events --since 24h`, `headroom models [--principal <id>] [--json|--agent]`
  (one non-flag principal value at most once),
  `headroom can <principal> <action-class> [--allow-unknown]`.
- `headroom credits [--json]`; `headroom credits set --principal <name> --available <n> --expires
  <YYYY-MM-DD|ISO instant> [--json]`; `headroom credits clear --principal <name> [--json]`. A
  date-only expiry is midnight UTC on that date.
- `headroom plan --meter <meter_id> --until reset [--reserve <percent>] [--target <points>] [--json]`.
- `headroom mcp` : stdio MCP, seventeen tools (`quota_status`, `quota_can`, `quota_events`, and
  more covering leases, cost, rate, spend, inbox, plan, gate, wait, fill, route, heartbeats and
  pasted `/usage` ingestion); see `docs/mcp-and-agents.md` for the full list and field shapes.
- `headroom heartbeat --owner <name> --every <duration> [--resume "<sentence>"] | --stop |
  list [--json]` (MCP `quota_heartbeat`): an orchestrator's promise to beat at least that
  often, recorded in the daemon's own store -- the one process that survives a crashed
  session. The daemon checks every registered heartbeat on each poll; one gone overdue by
  more than 2x its own interval gets exactly one `heartbeat_lapsed` event (never repeated for
  the same open lapse), delivered through the ordinary notify ledger/quiet-hours path; a later
  beat closes the lapse and may send one short `heartbeat_restored`. See `docs/notifications.md`.
- `headroom timer set --owner <name> --name <id> --at <ISO|+duration> --action "<text>"
  [--if-missed notify|drop] | list [--owner <name>] [--json] | clear --owner <name> --name
  <id>`: a named wake-up the daemon delivers, once, as one `headroom inbox` entry to its owner
  when due. Headroom only ever delivers the action text; it never executes it. `--if-missed
  notify` (default) also raises one `timer_missed` notification if the owner's heartbeat is
  currently lapsed when it fires; `--if-missed drop` never notifies.
- `skills/headroom/SKILL.md` + `AGENTS.md` snippet: pick the pool by capability first, ask Headroom if
  it can afford it, walk the user's fallback list filtered by budget, harvest only fungible
  work, `local_preference = fallback | prefer | never` (default fallback), never spawn into
  FREEZE, log overrides with a reason.
- Adapter SDK: an adapter is a pure function `(principal) → observations[]` plus a conformance
  fixture directory; third parties add vendors without touching the core.
- `headroom usage import --source <alias> --principal <alias> --path <file> [--format
  claude|codex]` / `import-status`: opt-in, explicitly-invoked ingestion of raw numeric usage
  counters (token counts, not a percent-of-limit) from one named Claude Code transcript or
  Codex CLI session-log file into a private `usage.db` (schema v2, vendor-discriminated),
  entirely separate from the observation/pace/`can` pipeline above. No directory walk, no
  daemon, no scheduler; see `docs/usage-prediction.md`.

## Acceptance criteria

| Area | Accepted when |
|---|---|
| Codex adapter and fixtures | The main and per-model rows match CodexBar's output; the engine revision is pinned |
| Claude adapter | Each configured config dir is its own row and matches the app's Usage screen within a few percent on two days; only the grant command can raise a Keychain dialog |
| Antigravity | A logged-in `agy` yields rows with the vendor's numbers; placeholder readings are annotated, never silently trusted |
| Store, events, pace | A fired Codex free reset yields `free_reset_used`; stale meters print UNKNOWN |
| Daemon, MCP, `can`, threshold | `quota_status` answers from a fresh Claude Code session; `--threshold 90` exits 2 |
| Routing, skill, docs, release | A fresh install gives truthful lines in under two minutes on macOS, Linux and Windows |

## Risks

1. Vendor drift and bot walls on private endpoints. Mitigation: pinned engine + conformance
   fixtures, per-datum freshness and truth, backoff, UNKNOWN instead of stale numbers.
2. Concurrent token refresh corrupting credential files. Mitigation: Headroom never refreshes
   tokens; the vendor CLI owns refresh. Open: CodexBarCore may refresh on its own; to be audited.
