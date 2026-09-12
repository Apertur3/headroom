<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="Headroom" src="docs/assets/logo-light.svg" width="300">
  </picture>
</p>

Headroom tells your agents how much of each AI subscription is left before they spend it.

One daemon reads quota across Claude, Codex, Antigravity, Grok, Kimi, and local
vLLM or llama.cpp pools. It keeps history, detects resets, and gives cooperating agents a budget
check before they start work. Stale or failed readings stay UNKNOWN. Antigravity support is
experimental; provider-specific limits are described below.

![headroom output](docs/assets/headroom-terminal.svg)

## The problem

Before an agent starts several jobs, it needs to know whether the account can afford them and
which other jobs have already reserved capacity. Headroom combines the vendor readings with
cooperative reservations to answer that question. When a reading is stale or failed it says UNKNOWN, and
UNKNOWN never counts as capacity.

## A budget check before a job

This synthetic example has 20% usage and another owner reserving 75%. The remaining capacity
cannot cover another 10-point job, so the child command never starts:

```text
$ headroom run --meter claude-main:all --need wk:10 --owner builder -- codex exec "Run the tests"
wk needs 10 more but only 0.0 left after 75.0% already leased before the 10% reserve
```

When there is enough capacity, `run` reserves it, starts the command, and releases the reservation
when it finishes. The check and reservation are atomic across processes. A plain `can` or `gate`
is advisory; use `run` or `can --lease` when starting work. These reservations coordinate agents
that use Headroom; they cannot stop unrelated tools from consuming the subscription.

## How it fits together

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/headroom-flow-dark.svg">
  <img alt="How Headroom fits together" src="docs/assets/headroom-flow-light.svg">
</picture>

Headroom reads Claude, Codex, Grok and Kimi through native TypeScript adapters.
Antigravity is experimental: it requires a logged-in `agy`, a running Headroom daemon,
and the native Swift reader built from source. The npm package currently has no pinned
native reader download. Gemini CLI is not required or supported for consumer subscriptions;
Google retired that access on June 18, 2026.

For Antigravity, Headroom reads agy's local quota summary without reading its token.
Missing or failed summaries stay UNKNOWN. An idle window with real fractions may carry
a doubt marker when its reset time looks synthetic. The endpoint contracts and native
reader build on [CodexBar](https://github.com/steipete/codexbar) (MIT).

## What you get

| | |
|---|---|
| Vendors and meters | Claude `all`, `fable`, `routines` and reported scoped meters; Codex `main`, `spark`, `credits`; Antigravity `gemini`, `claude-gpt`; Grok, Kimi; and local vLLM or llama.cpp `capacity` pools |
| Pace | HARVEST, NORMAL, CONSERVE, FREEZE or UNKNOWN per window, from a straight line burn with a grace period after each reset |
| Decisions | `can`, `gate`, `route`, `plan`, `fill`, `wait`, leases, per-meter reserves, and a spend ledger coordinate shared capacity and pacing |
| Views and automation | Terminal status, `dashboard`/`top`, `statusline --render`, `usage --paste` or `--clipboard`, JSON contract output, local daemon, and MCP tools |
| Operations | Interactive `setup`; the `notify configure` picker with calm, quiet and everything presets; `inbox`; `export` as JSON or CSV; `doctor --bundle`; `update`; `uninstall`; and shell `completion` |

Headroom is not a router. Which model is good at what is your opinion and changes monthly. Keep it
in `~/.headroom/routing.toml`; Headroom only filters your fallback list by budget. It also never sits in
the request path.

## Install

Node 22.13 or newer.

```sh
npm install -g headroomd
headroom accounts discover   # finds Claude, Codex, Antigravity, Grok and Kimi logins
headroom                     # one line per meter
```

On macOS and Linux, `brew install apertur3/tap/headroom` installs the same package and adds a
`brew services start headroom` service.

Already running Claude Code or another agent? Copy [skills/headroom/SKILL.md](skills/headroom/SKILL.md)
into its skills directory and say "set up headroom": the agent runs discovery, the doctor, the
background service and the MCP registration for you.

By hand, the same steps are one command:

```sh
headroom setup                # discovery, doctor, service, MCP registration -- asks before each change
```

Run `headroom notify configure` to choose notification channels, a preset and overrides. Run
`headroom update` only when you choose to install a newer package; `headroom uninstall` reverses
setup, and `headroom completion <bash|zsh|fish|pwsh>` prints a shell completion script.

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

`status`/`doctor` print a one-line notice when a newer `headroomd` is out; run `headroom update`
(never automatic) to install it -- see [Staying up to date](docs/quickstart.md#staying-up-to-date).

## Documentation

- [docs/quickstart.md](docs/quickstart.md): install to first truthful line, macOS, Linux and Windows
- [docs/concepts.md](docs/concepts.md): principal, meter, window, observation, pace states, leases, events
- [docs/mcp-and-agents.md](docs/mcp-and-agents.md): the MCP tools, example calls, and how an orchestrator should use them
- [docs/json-contract.md](docs/json-contract.md): the versioned field-by-field shape of every `--json` output and MCP tool result, and its compatibility promise
- [docs/vendors.md](docs/vendors.md): what Headroom reads per vendor, and its known live limitations

## Security

No secret touches disk or output. On macOS `headroom-claude-probe` reads the Claude Keychain token
through `/usr/bin/security`, which the Keychain item's own access list admits, and makes the usage
request itself, so the token never enters Node or stdout and no dialog is needed. It ships
inside the npm package as a universal binary, verified against a recorded SHA-256 before every use.
Tokens are otherwise read at call time from the Keychain or the vendor's own credential file and
dropped after the request. The daemon listens on a 0600 local
socket on macOS and Linux, or a current-user Windows named pipe. There is no telemetry, the engine
is pinned and checksum verified, and every query lands in an audit log. Details in [SECURITY.md](SECURITY.md).

## Status

Stable since 0.1.0 (2026-09-11). Used daily on one macOS machine with two Claude config dirs, one Codex home, one
Antigravity account and two local inference boxes. Every release is installed from the npm
registry into a fresh home on Linux (a Raspberry Pi 5) and Windows 11 (a VM) and walked through
the quickstart by script; CI runs the suite on all three platforms. Vendor endpoints are private and change without notice; Headroom pins, records
fixtures, backs off on 401, 403 and 429, and prints UNKNOWN instead of a stale number. Antigravity requires
the source-built native reader and a daemon-kept `agy`; see [vendor setup](docs/vendors.md#antigravity).

MIT. Third party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
