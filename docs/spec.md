# Tally spec v0.2 (2026-09-03, after review)

Brand Tally. Package and repo `keeptally`. Command `tally`.

## Problem

Anyone running agents across several AI subscriptions needs three answers at decision time:
how much capacity is left per account and meter, when it comes back, and what to do about it.
Existing tools (CodexBar, ccusage, claude-monitor, agentburn) answer only the first, as desktop
apps or single-account CLIs. Tally owns the second and third and keeps the first pluggable.

## Non-goals

- Not a menu-bar meter (CodexBar owns that; Tally builds on it and aims for its ecosystem list).
- Not a proxy or load balancer. Tally never sits in the request path.
- Not a capability router. Which model is good at what is the user's opinion in `routing.toml`.
- No UI, no TCP listener, no telemetry in v1.

## Concepts

| Term | Meaning |
|---|---|
| Principal | One credential location: `{vendor, location}`. Claude = a config dir, Codex = a `CODEX_HOME`, Antigravity = the Google login behind `agy`, local = a base URL. Stable id, e.g. `claude-main`. |
| Meter | One vendor-enforced limit on a principal, stable id `principal:meter`. Claude Max: `all`, `fable`, `routines`. Antigravity: `gemini`, `claude-gpt`. Codex: `main`, `spark`, `credits`. Local: `capacity`. |
| Window | A bucket inside a meter: `kind = rolling | fixed`, `minutes`, `enforcement = hard | soft`. |
| Observation | One sample of one window: typed quantity (`used`, `limit`, `remaining`, `unit = percent | tokens | requests | credits`), nullable `resets_at`, `observed_at` (vendor time if given) and `fetched_at`, `source`, `truth = official | estimated`, `freshness = fresh | stale | failed`, `confidence 0..1`, `adapter_version`, `upstream_schema_version`. Never a whole "reading" with mixed provenance; each datum carries its own. |
| Consumes | An action class maps to the set of meters it draws from. A Fable call on `claude-main` consumes `claude-main:all` and `claude-main:fable`. `tally can` checks every consumed meter; one frozen meter freezes the action. |
| Event | Separate record with id, kind (`reset_seen`, `free_reset_granted`, `free_reset_used`, `credits_changed`, `plan_changed`, `source_failed`, `source_recovered`), `origin = vendor_reported | inferred`, `confidence`, evidence (observation ids), and later corrections. Never embedded in observations. |
| Pace state | Per window: HARVEST (>10 pts under straight-line burn), NORMAL, CONSERVE (>10 pts over), FREEZE (past freeze reserve, overrides all), UNKNOWN (stale or failed). Ported from the fleet pace machine. |
| Cost model | `sunk` (subscriptions, capacity expires at reset) or `marginal` (local inference, energy per hour). |

## Fail-closed semantics

Unknown is never capacity. A stale or failed window is `UNKNOWN`, printed as such on every
surface, and `tally can` answers NO for it unless `--allow-unknown` is passed. Staleness
threshold per meter, default 15 minutes. Inferred events carry confidence and are labelled
inferred; a drop from 82% to 7% during backoff is `reset_seen` with low confidence, not a fact.

## Architecture

```
tally CLI ──┐                     ┌── engine: tally-engine (Swift, links CodexBarCore pinned to a tag; Keychain enabled; emits observations)
tally MCP ──┼─ Unix socket ─ daemon ┼── fallback engine: upstream CodexBarCLI binary (pinned, SHA-256) via schema adapter
statusline ─┘        │            ├── native:local adapter (OpenAI-compatible /v1/models, vLLM /metrics, llama.cpp /health)
                     ├── store: SQLite under ~/.tally/ (observations, events, audit), 0600, canonicalized paths
                     ├── scheduler: per-principal interval, jitter, coalescing, exponential backoff on 401/403/429
                     └── policy: pace states, consumes graph, routing filter, thresholds
```

- **Engine (primary).** `CodexBarCore` is an MIT SwiftPM library building on macOS 14+ and
  Linux. `engine/` holds `tally-engine`, a thin Swift CLI that depends on it at a pinned tag,
  enables Keychain reads for every Claude config dir (the upstream CLI disables them), loops over
  principals in-process, and prints observations in Tally's schema. Prebuilt macOS and Linux
  binaries ship in Tally's releases; the TypeScript side downloads, checksum-verifies, and, when
  upstream publishes attestations, signature-verifies them. Updating = bump the tag, rebuild,
  run conformance fixtures. Upstream drift breaks a test, not a user.
- **Engine (fallback).** Slice 2's runner for the upstream CodexBarCLI stays as a fallback and as
  the conformance oracle.
- **Antigravity.** `agy` has no server mode but bootstraps its local HTTPS server when started
  under a pseudo-terminal (`script -q /dev/null agy`), verified 2026-09-03 with real numbers.
  The daemon supervises a hidden `agy` only while polling, then stops it; cold start ~20s.
- **Local pools.** `kind = "local"` principals with `base_url`, optional `wake` command that Tally
  reports and never runs. State `UP | BUSY | DOWN`, model id, vLLM queue depth.
- **Registry.** `~/.tally/accounts.toml`, auto-discovered from `~/.claude*`, `~/.codex*`,
  `~/.gemini`, confirmed by the user. Committed example in `examples/`.
- **Daemon.** Unix socket `~/.tally/tally.sock`, JSON-RPC. `tally install-service` writes a
  launchd or systemd unit. Without a daemon the CLI does a one-shot read and says so.

## Security (see SECURITY.md; additions from review)

- Same-UID code (npm packages, editor extensions, other agents) is inside the trust boundary of
  a 0600 socket. Mitigation: request coalescing and per-principal poll rate limits so no caller
  can force credential-backed polls or trigger vendor defenses; audit log records callers.
- Canonicalize and `lstat` every path under `~/.tally/`, config dirs and credential files;
  reject symlinks and unsafe parent ownership or mode before use.
- Engine runs with a minimal environment (only the variables it needs), bounded stderr capture,
  allowlist logging; canary-secret tests assert no leakage through stderr, exceptions or JSON.
- Checksum proves reproducibility, not trust: pins are bumped only by an explicit human update;
  release attestations verified when upstream provides them.
- No TCP listener in v1. Removed until a real need exists.

## Surfaces

- `tally` — one line per meter, freshness always visible:
  `claude-main:all  5h 3% ↻17:10 HARVEST | wk 61% ↻Sat 14:00 CONSERVE  (fresh 2m)`
- `tally --json`, `--principal X`, `--threshold N` (exit 2 if any window ≥ N),
  `tally events --since 24h`, `tally can <principal> <action-class> [--allow-unknown]`.
- `tally mcp` — stdio MCP: `quota_status`, `quota_can`, `quota_events`.
- `skills/tally/SKILL.md` + `AGENTS.md` snippet: pick the pool by capability first, ask Tally if
  it can afford it, walk the user's fallback list filtered by budget, harvest only fungible
  work, `local_preference = fallback | prefer | never` (default fallback), never spawn into
  FREEZE, log overrides with a reason.
- Adapter SDK: an adapter is a pure function `(principal) → observations[]` plus a conformance
  fixture directory; third parties add vendors without touching the core.

## Slices and acceptance

| # | Slice | Accepted when |
|---|---|---|
| 2 | Upstream engine runner + Codex adapter + fixtures | DONE 2026-09-03: Codex main and spark match CodexBar; SHA pinned |
| 3 | `tally-engine` on CodexBarCore with Keychain | `claude-main` and `claude-2` rows; main matches the app's Usage screen within a few percent, twice on two days; Codex and Antigravity rows from the same engine |
| 4 | Antigravity headless | DONE as spike 2026-09-03; supervision lands with the daemon |
| 5 | Store, observations, events, pace, consumes graph | A fired Codex free reset yields `free_reset_used`; stale meters print UNKNOWN |
| 6 | Daemon + MCP + `can` + threshold | `quota_status` answers from a fresh Claude Code session in both profiles; `--threshold 90` exits 2 |
| 7 | Routing, skill, adapter SDK docs, README, public | `npx keeptally` gives truthful lines in under two minutes on a clean machine; owner approves README |

## Risks

1. Vendor drift and bot walls on private endpoints. Mitigation: pinned engine + conformance
   fixtures, per-datum freshness and truth, backoff, UNKNOWN instead of stale numbers.
2. Concurrent token refresh corrupting credential files. Mitigation: Tally never refreshes
   tokens; the vendor CLI owns refresh. Open: CodexBarCore may refresh on its own; audit in slice 3.
