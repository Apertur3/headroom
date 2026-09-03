# Tally

**Your agents know their budget.**

Tally is a local daemon, CLI and MCP server that reports the remaining capacity of every AI
subscription and account you own: Claude, Codex, Gemini via Antigravity, and any number of
accounts per vendor. It remembers history, detects resets and free-reset grants, and turns the
numbers into pace states an orchestrator can act on.

```
$ tally
claude-main:all   5h 15% ↻22:09 HARVEST | wk 67% ↻Sat 13:59 NORMAL   (fresh <1m)
claude-2:all      UNKNOWN (OAuth credentials invalid)                  (failed <1m)
codex-main:main   5h n/a | wk 19% ↻Sep 10 15:08 NORMAL                (fresh <1m)
antigravity:gemini   wk 84% ↻Sep 8 23:11 CONSERVE                     (fresh <1m)

$ tally can gemini-bulk
NO antigravity:gemini CONSERVE (wk 84% CONSERVE)
```

## Why

Meters exist. CodexBar shows them in your menu bar, ccusage estimates them from logs. None of
them answer the question an orchestrating agent has to ask before it spends: *can this account
afford this job right now, and if not, who is next?* Tally answers that, and refuses to guess:
a stale or failed reading is UNKNOWN, and UNKNOWN is not capacity.

## What it does

- **Every account, every meter.** An account is a credential location (`~/.claude`,
  `~/.claude2`, `~/.codex`, the Antigravity login). A meter is one vendor limit inside it. Claude
  Max has `all`, `fable`, `routines`; Antigravity has `gemini` and `claude-gpt`.
- **Truth first.** Reads the vendor's own usage endpoints with your own tokens, read at call time
  from the macOS Keychain or the vendor's credential file. Tokens are never written or logged.
- **Memory.** SQLite history, `reset_seen`, `free_reset_granted`, `free_reset_used`,
  `source_failed` events with confidence.
- **Pace states.** HARVEST, NORMAL, CONSERVE, FREEZE, UNKNOWN per window, from a straight-line
  burn model with a grace period after each reset.
- **Go / no-go.** `tally can <action-class>` checks every meter the action consumes. One frozen
  scoped meter blocks the action even when the parent has room.
- **Agent surfaces.** `tally --json`, `tally --threshold 90` (exit 2), a Unix-socket daemon, a
  stdio MCP server with `quota_status`, `quota_can`, `quota_events`, and a skill that tells an
  orchestrator how to use them.

## What it is not

Not a router. Which model is good at what is your opinion and changes monthly; keep it in
`~/.tally/routing.toml`. Tally only filters your ordered fallback list by budget. Not a proxy:
Tally never sits in the request path. Not a menu-bar app.

## Install

```sh
npx keeptally engine install     # pins and verifies the sensing engine
npx keeptally accounts discover  # finds ~/.claude*, ~/.codex*, Antigravity
npx keeptally                    # one truthful line per meter
npx keeptally install-service    # launchd or systemd unit for the daemon
```

Register the MCP server in each Claude Code profile:

```sh
claude mcp add tally -- npx keeptally mcp
CLAUDE_CONFIG_DIR=~/.claude2 claude mcp add tally -- npx keeptally mcp
```

Codex and Gemini agents call the CLI. Copy `skills/tally/SKILL.md` into your skills directory.

## How it senses

Tally builds on [CodexBar](https://github.com/steipete/codexbar) (MIT) by Peter Steinberger.
`tally-engine` is a small Swift CLI that links `CodexBarCore` at a pinned tag and adds one
thing the upstream CLI refuses: reading Claude Code's Keychain item for every config dir, so two
Claude subscriptions on one machine are two rows. Updating the engine is a tag bump plus
conformance fixtures. The upstream CodexBarCLI binary remains as a checksum-pinned fallback.

Vendor endpoints are private and change without notice. Tally pins, records fixtures, backs off
on 401/403/429, and prints UNKNOWN rather than a stale number.

## Security

Read `SECURITY.md`. In one line: no secret on disk, no secret in output, local socket only, no
telemetry, pinned and verified engine, audit log of every query.

## Status

Pre-alpha. Verified daily on one machine with two Claude config dirs, one Codex home and one
Antigravity account. Local inference pools (vLLM, llama.cpp) are next.

## Licence

MIT. Third-party notices in `THIRD_PARTY_NOTICES.md`.
