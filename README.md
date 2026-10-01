<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="Headroom" src="docs/assets/logo-light.svg" width="300">
  </picture>
</p>

**Headroom tells your agents how much of each AI subscription is left, before they spend it.**

<p align="center">
  <a href="https://github.com/Apertur3/headroom/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Apertur3/headroom/actions/workflows/ci.yml/badge.svg?branch=master"></a>
  <a href="https://www.npmjs.com/package/headroomd"><img alt="npm" src="https://img.shields.io/npm/v/headroomd"></a>
  <a href="https://github.com/Apertur3/headroom/actions/workflows/release.yml"><img alt="Release" src="https://github.com/Apertur3/headroom/actions/workflows/release.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

![The Headroom browser dashboard: two subscriptions, their 5-hour and weekly windows, pace states and a remaining-capacity chart](docs/assets/dashboard.png)

<sub>Synthetic data. Regenerate with `node scripts/render-dashboard-demo.mjs` (see [CONTRIBUTING.md](CONTRIBUTING.md)).</sub>

## Install in 30 seconds

Node 22.13 or newer.

```sh
npm install -g headroomd      # or: brew install apertur3/tap/headroom
headroom setup                # finds your logins, runs the doctor, asks before each change
headroom                      # one line per meter
```

One daemon reads quota across Claude, Codex, Antigravity, Grok, Kimi, and local vLLM or
llama.cpp pools. It keeps history, detects resets, and gives cooperating agents a budget check
before they start work. Stale or failed readings stay UNKNOWN. Antigravity support is
experimental; provider-specific limits are described below.

![headroom output](docs/assets/headroom-terminal.svg)

## Why

An agent that fans out several jobs needs two answers first: can this account afford them, and
which other jobs have already reserved capacity? Vendor screens answer neither for a program,
and a guessed number is worse than none: an orchestrator that believes a stale 20% will burn the
week in an afternoon. Headroom combines vendor readings with cooperative reservations. When a
reading is stale or failed it says UNKNOWN, and UNKNOWN never counts as capacity.

## Design principles

Each of these is a rule the code enforces and a test pins. Past real-world breakage is the
reason for every one.

- **Fail closed: never a fake number.** A missing, stale, held or inconsistent reading becomes
  UNKNOWN, and `can` answers NO for it unless you pass `--allow-unknown`
  ([`freshnessGate`, `canConsume`](src/policy.ts), tested in
  [`store-policy.test.ts`](test/store-policy.test.ts)). Antigravity lanes that report no usage are
  classified as blocked, idle or unknown, never filled in
  ([`antigravity-lanes.ts`](src/antigravity-lanes.ts),
  [`antigravity-lane-classifier.test.ts`](test/antigravity-lane-classifier.test.ts)).
- **A stale-lane canary that cannot be silenced and does not spam humans.** A meter lane with no
  fresh reading for 6 hours (configurable) raises an alert into the inbox and `headroom doctor`.
  It runs before and independently of the notification config, so a muted channel or
  `events_off` cannot hide it. External channels get nothing per lane; at most one plain-language
  message per principal per episode, after 24 hours, held during quiet hours
  ([`canary.ts`](src/canary.ts), [`stale-lane-canary.test.ts`](test/stale-lane-canary.test.ts)).
- **Process hygiene: only kill what Headroom provably started.** A process is signalled only if
  recorded evidence (pid, command and start time from when Headroom launched it) still matches
  the live process, re-checked immediately before every signal, so a recycled pid is never hit.
  An age watchdog reaps Headroom-started `agy` processes that outlive their limit
  ([`process-tree.ts`](src/process-tree.ts), [`agy-watchdog.ts`](src/agy-watchdog.ts),
  [`antigravity-keepalive-stop-recycled-pid.test.ts`](test/antigravity-keepalive-stop-recycled-pid.test.ts),
  [`agy-watchdog.test.ts`](test/agy-watchdog.test.ts)). The test suite itself fails if any
  process it started outlives the run ([`global-leak-gate.ts`](test/global-leak-gate.ts)).
- **Secrets only in the OS secret store.** Headroom's own credentials (notification tokens) are
  read at use time from the macOS Keychain (`secret-tool` on Linux, Credential Manager on
  Windows) and never written to disk; vendor tokens are read from the vendor's own store at call
  time and dropped. Output and logs are redacted
  ([`notify.ts`](src/notify.ts), [`security.ts`](src/security.ts),
  [`security.test.ts`](test/security.test.ts), [SECURITY.md](SECURITY.md)).
- **A redacted fixture per past breakage.** Every Antigravity failure shape seen in the field
  has a fixture (recorded and redacted, or synthetic) and a test that runs it through the real
  code path ([`test/fixtures/antigravity/`](test/fixtures/antigravity),
  [`record-antigravity-fixture.sh`](scripts/record-antigravity-fixture.sh)). The repo
  also scans itself and its packed npm tarball for private addresses, emails and home paths
  ([`privacy-sweep.sh`](scripts/privacy-sweep.sh), run in CI).

## Honest numbers

| | |
|---|---|
| Tests | 1,898 (`npm test`, vitest; 1 skipped), run on every push |
| CI platforms | macOS, Ubuntu and Windows (`ubuntu-latest`, `windows-latest`, `macos-latest`): lint, tests, build, `npm pack --dry-run`, privacy sweep, `npm audit` |
| Daily use | one macOS machine; this is the only environment a person uses every day |
| Install from the packed tarball | scripted cold-install smoke test ([`smoke-cold.sh`](scripts/smoke-cold.sh)) runs in the release workflow; also checked by hand on macOS and on Linux ARM64 |
| Not verified | an install from the npm registry on a real Windows machine; a person using it daily on Windows or Linux with real accounts. On Windows only the source is covered by CI |
| Antigravity | experimental; macOS 14 or later only, and it depends on a private local endpoint that the vendor can change |
| Vendor endpoints | private and unversioned. Headroom pins them, records redacted fixtures and prints UNKNOWN when a shape changes, but it cannot promise they keep working |

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
Antigravity is experimental and supported on macOS 14 or later: it requires a logged-in
`agy` and a running Headroom daemon. The npm and Homebrew packages include a universal
macOS reader, verified by SHA-256 before use. Gemini CLI is not required or supported for consumer subscriptions;
Google retired that access on June 18, 2026.

For Antigravity, Headroom reads agy's local quota summary without reading its token.
Missing or failed summaries stay UNKNOWN. An idle window with real fractions may carry
a doubt marker when its reset time looks synthetic. A five-hour window entirely absent
from an otherwise-successful response (a genuinely idle rolling window) prints `n/a`
instead of UNKNOWN and does not block a budget check. The endpoint contracts and native
reader build on [CodexBar](https://github.com/steipete/codexbar) (MIT).

## What you get

| | |
|---|---|
| Vendors and meters | Claude `all`, `fable`, `routines` and reported scoped meters; Codex `main`, `spark`, `credits`; Antigravity `gemini`, `claude-gpt`; Grok, Kimi; and local vLLM or llama.cpp `capacity` pools |
| Pace | HARVEST, NORMAL, CONSERVE, FREEZE or UNKNOWN per window, from a straight line burn with a grace period after each reset |
| Decisions | `can`, `gate`, `route`, `plan`, `fill`, `wait`, leases, per-meter reserves, and a spend ledger coordinate shared capacity and pacing |
| Views and automation | Terminal status, `dashboard`/`top` (and `--html <path>` browser report), `statusline --render`, `usage --paste` or `--clipboard`, JSON contract output, local daemon, and MCP tools |
| Operations | Interactive `setup`; the `notify configure` picker with calm, quiet and everything presets; `inbox`; `export` as JSON or CSV; `doctor --bundle`; `update`; `uninstall`; and shell `completion` |

Headroom is not a router. Which model is good at what is your opinion and changes monthly. Keep it
in `~/.headroom/routing.toml`; Headroom only filters your fallback list by budget. It also never sits in
the request path.

## Install in detail

The three commands above are the short path. Discovery on its own:

```sh
headroom accounts discover   # finds Claude, Codex, Antigravity, Grok and Kimi logins
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
`headroom can <class> --owner <your-agent-name>` works immediately with the example action classes (`claude-fable`, `codex-build`,
`gemini-bulk`) -- edit `routing.toml` to match your accounts.

Keep an optional second profile that is deliberately logged out without polling it: add
`enabled = false` to its `[[accounts]]` block, or run `headroom accounts disable <name>`.
It remains configured and can be restored with `headroom accounts enable <name>`.

Register the MCP server in each Claude Code profile:

```sh
claude mcp add --scope user headroom -- headroom mcp
CLAUDE_CONFIG_DIR=~/.claude2 claude mcp add --scope user headroom -- headroom mcp
```

Codex and Gemini agents call the CLI. Copy `skills/headroom/SKILL.md` into your skills directory.
Full walkthrough, including what each step grants and why: [docs/quickstart.md](docs/quickstart.md).

`status`/`doctor` print a one-line notice when a newer `headroomd` is out; run `headroom update`
(never automatic) to install it -- see [Staying up to date](docs/quickstart.md#staying-up-to-date).

### Human dashboard and browser report

Open the terminal overview, or export a local browser snapshot:

```sh
headroom dashboard
headroom dashboard --once --ascii
```

Use Tab to select a meter, `v` for details, and `e` for events. Both chart views show
recorded remaining capacity, with gaps where readings are missing or untrusted.

To open the same recorded history in a browser:

```sh
headroom dashboard --html report.html
```

Open the generated file in your browser. The report shows subscription usage and reset times in an overview, with selectable window charts and sample details. It supports light and dark themes and makes no external requests. It is a snapshot: generate it again for newer readings. Existing files are preserved unless you pass `--force`; new files use mode 0600 on systems that support Unix permissions.

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

Stable since 0.1.0 (2026-09-11); the current release is on npm. Vendor endpoints are private and
change without notice: Headroom pins them, records fixtures, backs off on 401, 403 and 429, and
prints UNKNOWN instead of a stale number. What is and is not verified is in
[Honest numbers](#honest-numbers). Antigravity requires macOS and a daemon-kept `agy`; see
[vendor setup](docs/vendors.md#antigravity).

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the issues labelled
[good first issue](https://github.com/Apertur3/headroom/labels/good%20first%20issue).

MIT. Third party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
