<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="Headroom" src="docs/assets/logo-light.svg" width="300">
  </picture>
</p>

Headroom tells your agents how much of each AI subscription is left before they spend it.

One daemon reads the real meters of every account you own: Claude and Codex today, any number of
accounts per vendor, and local inference boxes. Google Antigravity is experimental: the adapter is
in, but on our account its local server only serves an availability placeholder, so the rows read
UNKNOWN rather than a fake 100%. It keeps history, notices resets and free
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
quota summary; on our account that server currently serves only an availability placeholder, which
Headroom refuses, so those rows read UNKNOWN. The older remote Google OAuth path is deprecated for
the free tier.
dropped afterwards. The endpoint contracts were learned from
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

Not on npm yet. Until the first release, clone the repo, run `npm install && npm run build`, and
use `node dist/cli.js` where the commands below say `npx headroomd`.

```sh
npx headroomd accounts discover  # find ~/.claude*, ~/.codex*, Antigravity; also seeds policy/routing.toml
npx headroomd doctor             # one-line installation and daemon diagnostics, with next steps on a fresh install
npx headroomd keychain grant     # macOS: one Claude Keychain prompt; choose Always Allow
npx headroomd                    # one line per meter
npx headroomd install-service    # launchd, systemd user unit, or Windows Task Scheduler
npx headroomd --help             # full command list; `headroom <command> --help` for one command
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

- [docs/quickstart.md](docs/quickstart.md): clone to first truthful line, macOS, Linux and Windows
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

Beta. Verified daily on one macOS machine with two Claude config dirs, one Codex home, one
Antigravity account and two local inference boxes; Linux and Windows are verified through CI, not
yet by hand. Vendor endpoints are private and change without notice; Headroom pins, records
fixtures, backs off on 401, 403 and 429, and prints UNKNOWN instead of a stale number. Google can
reject the remote Antigravity fallback for unsupported Gemini Code Assist tiers (for example
`UNSUPPORTED_CLIENT`); keep the daemon running so its warm `agy` source remains available.

MIT. Third party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
