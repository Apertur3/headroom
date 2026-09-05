<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="Headroom" src="docs/assets/logo-light.svg" width="300">
  </picture>
</p>

Headroom tells your agents how much of each AI subscription is left before they spend it.

One daemon reads the real meters of every account you own: Claude and Codex today, any number of
accounts per vendor, and local inference boxes. Google Antigravity is experimental: the adapter
reads the daemon-kept `agy` local quota summary and shows it as-is, with an idle window flagged
rather than hidden -- only an availability-only payload or a reading that contradicts the last one
reads UNKNOWN. It keeps history, notices resets and free
reset grants, and turns the numbers into a go or no-go an orchestrator can act on.

![headroom output](docs/assets/headroom-terminal.svg)

## The problem

Menu bar meters and log estimators show you the number. They don't answer the question an agent
has to ask before it fans out ten subagents: can this account afford the job right now, and if
not, who is next? Headroom answers that. When a reading is stale or failed it says UNKNOWN, and
UNKNOWN never counts as capacity.

## How it fits together

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/headroom-flow-dark.svg">
  <img alt="How Headroom fits together" src="docs/assets/headroom-flow-light.svg">
</picture>

Headroom reads each vendor itself, in TypeScript, on macOS, Linux and Windows: the Claude Code
token from the Keychain or credentials file, the Codex token from its auth file, and, experimentally, the Antigravity
token from the agy CLI. For Antigravity the daemon keeps an agy process warm and reads its local
quota summary: a summary with real fractions is shown as-is, and an idle window whose reset equals
fetch time plus window length is shown too, with a doubt marker, rather than replaced with UNKNOWN
on a heuristic -- only an availability-only payload or a reading that contradicts the previous one
becomes UNKNOWN. Google's remote quota endpoint answers 403 for free-tier accounts, so it serves as
diagnosis there, not as a usable reading. Each call goes straight to the vendor's usage endpoint
and the token is dropped afterwards. The endpoint contracts were learned from
[CodexBar](https://github.com/steipete/codexbar) (MIT) by Peter Steinberger; an optional engine
links its library for providers Headroom does not cover natively.

## What you get

| | |
|---|---|
| Meters | One row per account and limit family: Claude `all`, `fable`, `routines`; Codex `main`, `spark`; Antigravity `gemini`, `claude-gpt`; local `capacity` |
| Pace | HARVEST, NORMAL, CONSERVE, FREEZE or UNKNOWN per window, from a straight line burn with a grace period after each reset |
| Memory | SQLite history plus `reset_seen`, `free_reset_granted`, `free_reset_used` and `source_failed` events, each with a confidence |
| Go or no-go | `headroom can <action>` checks every meter the action draws from. A frozen Fable meter blocks a Fable call even when the account has room overall |
| Surfaces | `headroom --json`, `headroom --threshold 90` (exit 2), a Unix socket daemon, an MCP server with `quota_status`, `quota_can`, `quota_events`, and a skill that tells an orchestrator how to use them |

Headroom is not a router. Which model is good at what is your opinion and changes monthly. Keep it
in `~/.headroom/routing.toml`; Headroom only filters your fallback list by budget. It also never sits in
the request path.

## Install

Node 22.13 or newer.

```sh
npm install -g headroomd
headroom accounts discover   # finds your Claude, Codex and Antigravity logins
headroom                     # one line per meter
```

Already running Claude Code or another agent? Copy [skills/headroom/SKILL.md](skills/headroom/SKILL.md)
into its skills directory and say "set up headroom": the agent runs discovery, the doctor, the one
macOS Keychain prompt, the background service and the MCP registration for you.

By hand, the same steps are:

```sh
headroom doctor              # what is missing, with the next command for each item
headroom keychain grant      # macOS: one Claude Keychain prompt; choose Always Allow
headroom install-service     # launchd, systemd user unit, or Windows Task Scheduler
headroom --help              # full command list; `headroom <command> --help` for one command
```

`accounts discover` prints what it wrote (`Wrote ~/.headroom/accounts.toml (4 accounts). Next: headroom
doctor`) and, the first time, seeds `~/.headroom/policy.toml` and `routing.toml` from `examples/` so
`headroom can <class>` works immediately with the example action classes (`claude-fable`, `codex-build`,
`gemini-bulk`) -- edit `routing.toml` to match your accounts.

Register the MCP server in each Claude Code profile:

```sh
claude mcp add headroom -- npx headroomd mcp
CLAUDE_CONFIG_DIR=~/.claude2 claude mcp add headroom -- npx headroomd mcp
```

Codex and Gemini agents call the CLI. Copy `skills/headroom/SKILL.md` into your skills directory.
Full walkthrough, including what each step grants and why: [docs/quickstart.md](docs/quickstart.md).

## Documentation

- [docs/quickstart.md](docs/quickstart.md): install to first truthful line, macOS, Linux and Windows
- [docs/concepts.md](docs/concepts.md): principal, meter, window, observation, pace states, leases, events
- [docs/mcp-and-agents.md](docs/mcp-and-agents.md): the MCP tools, example calls, and how an orchestrator should use them
- [docs/vendors.md](docs/vendors.md): what Headroom reads per vendor, and its known live limitations

## Security

No secret touches disk or output. On macOS `headroom-claude-probe` reads the Claude Keychain token
and makes the usage request itself, so the token never enters Node or stdout. It ships inside the
npm package as a universal binary, verified against a recorded SHA-256 before every use, and is
ad-hoc signed rather than Developer ID signed -- fine for a beta, but it means each package update
is a new signing identity to macOS. Run `headroom keychain grant` once and choose **Always Allow**;
an updated probe binary prompts once again. Tokens are otherwise read at call time from the Keychain or the
vendor's own credential file and dropped after the request. The daemon listens on a 0600 local
socket on macOS and Linux, or a current-user Windows named pipe. There is no telemetry, the engine
is pinned and checksum verified, and every query lands in an audit log. Details in [SECURITY.md](SECURITY.md).

## Status

Beta. Used daily on one macOS machine with two Claude config dirs, one Codex home, one
Antigravity account and two local inference boxes. Every release is installed from the npm
registry into a fresh home on Linux (a Raspberry Pi 5) and Windows 11 (a VM) and walked through
the quickstart by script; CI runs the suite on all three platforms. Vendor endpoints are private and change without notice; Headroom pins, records
fixtures, backs off on 401, 403 and 429, and prints UNKNOWN instead of a stale number. Google can
reject the remote Antigravity fallback for unsupported Gemini Code Assist tiers (for example
`UNSUPPORTED_CLIENT`); keep the daemon running so its warm `agy` source remains available.

MIT. Third party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
