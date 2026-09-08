# Quickstart

Five minutes from install to a line of output you can trust, on macOS or Linux. Windows steps
are noted separately at the end.

## 1. Install

Headroom is on npm as `headroomd` and needs Node 22.13 or newer.

```sh
npm install -g headroomd
headroom version
```

On macOS and Linux, Homebrew installs the same package and brings Node with it:

```sh
brew install apertur3/tap/headroom
headroom version
```

The Homebrew install also registers the daemon as a Homebrew service, so `brew services start
headroom` replaces step 6's `headroom install-service` and `brew services stop headroom` stops
it again. Logs land in `$(brew --prefix)/var/log/headroom/`. Everything else in this walkthrough
is the same either way.

`npx headroomd <command>` works without installing, but the daemon, the MCP registration and
the service installer all expect a `headroom` command on your PATH, so the global install is the
one this walkthrough assumes. To work from source instead, clone the repository, run
`npm install && npm run build`, and use `node dist/cli.js` where the steps say `headroom`.

## Or run `headroom setup`

`headroom setup` does sections 2 through 7 below for you, one step at a time: it prints what
each step is about to do, asks a yes/no question before anything that changes something, and
skips the MCP registration if you say no. `--dry-run` shows the whole plan without changing
anything; `--yes` accepts the main setup steps; `--skip-service` and `--skip-mcp` leave those two
steps out entirely. The sections below are
still the explanation of what each step does and why; read them if you want the detail, or if
something `setup` reports needs a closer look.

After the service step, setup optionally offers notification channels, presets and quiet hours.
`--yes` skips notifications; run `headroom notify configure` later to choose or change them.

## 2. Find your accounts

```sh
headroom accounts discover
```

This scans your home directory for `~/.claude*` and `~/.codex*` directories and an Antigravity
CLI install, writes what it finds to `~/.headroom/accounts.toml` (mode 0600), and prints the same
TOML to stdout so you can check it before trusting it, followed by a confirmation line:

```
Wrote /Users/you/.headroom/accounts.toml (4 accounts). Next: headroom doctor
Seeded /Users/you/.headroom/policy.toml from examples/policy.toml.
Seeded /Users/you/.headroom/routing.toml from examples/routing.toml (action classes: claude-fable, codex-build, gemini-bulk). Edit to match your accounts.
```

The `policy.toml`/`routing.toml` seed step only runs when those files don't already exist, so it
never overwrites a config you've customized. The three seeded action classes (`claude-fable`,
`codex-build`, `gemini-bulk`) let `headroom can <class>` work right away; edit `routing.toml` to
match the accounts you actually have, and rename or drop `accounts.toml` entries you don't want
polled. `examples/accounts.toml` shows the full shape, including the commented-out `local` block
for a vLLM or llama.cpp box.

If `accounts.toml` doesn't exist yet and you run a bare `headroom` first, it says so plainly:

```
No accounts configured yet. Run: headroom accounts discover
```

## 3. Check the installation

```sh
headroom doctor
```

A read-only diagnostic: principals configured, credential files or Keychain items present, the
sensing engine's hash, the daemon socket, the Antigravity `agy` keepalive, and
`policy.toml`/`routing.toml`. Nothing it checks reads a token's contents. FAIL is reserved for
things that actually block reading a configured principal (an unresponsive daemon socket, an
invalid `accounts.toml`); a daemon that was simply never installed, or optional pieces like the
native sensing engine, show as WARN or INFO instead. On a brand-new install (no daemon has ever
started) the checks end with an ordered punch list:

```
Next steps:
1. headroom install-service
2. claude mcp add headroom -- npx headroomd mcp
```

Run `headroom --help` any time for the full command list, or `headroom <command> --help` for one
command's usage.

## 4. Check the Claude credential (macOS only)

```sh
headroom keychain grant
```

Claude Code stores its OAuth token in the macOS Keychain, and Headroom's probe reads it through
`/usr/bin/security`, which the Keychain item's own access list admits -- there is no dialog to
answer and nothing to grant, so this command only runs the probe once and reports either
`claude-main: credential readable, no dialog needed (probe: /path/to/headroom-claude-probe)` or
the real error (an absent login, a `security` run that failed, an expired token). On Linux and
Windows there is no Keychain at all: Headroom reads the token straight from
`<config-dir>/.credentials.json`.

## 4b. Or skip the credential read entirely: `headroom statusline`

Claude Code hands its `statusLine` command a JSON object on every prompt render, containing
`rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at`) -- the exact
numbers the vendor probe exists to fetch, already sitting on stdin for free.
Register `headroom statusline` as that command and Headroom reads it as a zero-auth source instead:

```json
{
  "statusLine": { "type": "command", "command": "headroom statusline" }
}
```

Add this to `~/.claude/settings.json` for the default profile, or `<CLAUDE_CONFIG_DIR>/settings.json`
for any other profile (e.g. `~/.claude2/settings.json` for `claude-2`) -- one line per profile,
same as `keychain grant --principal <name>`. Claude Code only supports one `statusLine` command; if you
already have one, chain it instead of replacing it:

```json
{
  "statusLine": { "type": "command", "command": "headroom statusline --chain 'my-existing-statusline.sh'" }
}
```

`headroom statusline` still writes the snapshot and prints Headroom's own compact bar
(`5h 37% ↻13:19 | wk 17% ↻Sat 14:00`) when `--chain` is omitted; with it, it runs your command with
the same stdin and prints your command's own output instead, so the visible status bar doesn't
change.

### Put the whole picture in the status bar: `--render`

`headroom statusline --render` writes the same snapshot and then prints one line for Claude Code's
own status bar that combines both halves of what you need to see while you work:

```json
{
  "statusLine": { "type": "command", "command": "headroom statusline --render" }
}
```

Already have a status line command? Keep it, and put `--render` in front of `--chain`; your
command's output prints first, on its own row, and Headroom's line follows on the next one:

```json
{
  "statusLine": { "type": "command", "command": "headroom statusline --render --chain 'my-existing-statusline.sh'" }
}
```

The line reads left to right: this session's own 5h window with its percentage and a countdown to
its reset, then this session's weekly percentage, then any model-scoped bucket the payload carried
(Fable, Routines), then one segment per other principal Headroom knows about -- its name, the
window that constrains it, its percentage -- then the number of active leases and the protected
reserve on your own meter. A pace state (`HARVEST`, `CONSERVE`, `FREEZE`, `UNKNOWN`) is printed
after a segment's numbers only when it is not `NORMAL`, so the bar stays quiet while everything is
on pace. The most constrained principal comes first, and in compact style anything past 120
characters is dropped from the right and counted as a trailing `+N`.

- `--style full` adds each window's burn and its projected time to stall, the same figures
  `headroom rate` prints, and drops the width budget.
- `--meters codex,claude-main:fable` narrows the Headroom half to the meters, principals or window
  labels you name. Your own session's two windows are always shown.
- `--color` forces ANSI colour on the pace states (Claude Code renders ANSI in the status line).
  Colour is on by itself only when stdout is a TTY, and `NO_COLOR` turns it off.

**The two numbers for your own session are exact**: they come from the JSON Claude Code just piped
in, on this very render. **Everything else is read from Headroom's store**, through the daemon when
it answers within 150 ms and straight from the store when it does not, so those figures can be up
to one poll interval old (`poll_interval_minutes`, five minutes by default). Nothing on this path
ever calls a vendor, so the line cannot delay your prompt.

Every reading this way snapshots to `~/.headroom/statusline/<profile>.json` (0600); the collector
prefers a snapshot under 10 minutes old over the vendor probe, and reads a Fable-scoped or other
model-scoped bucket the same way if Claude Code ever includes one in `rate_limits`. **A profile
set up this way is read without opening the Keychain item at all.** A profile whose statusline
hasn't rendered yet (or has gone stale) still falls back to the probe.

## 4c. When the meter is blocked, paste the panel

Some readings only ever exist on screen: a probe that cannot reach the credential, a machine where the
statusline has not rendered yet, or a model-scoped weekly bar sitting near its cap while the
account-wide window still looks free. Run `/usage` in Claude Code, copy the panel, and hand it to
Headroom:

```sh
headroom usage --clipboard              # macOS, or Linux with xclip or wl-paste, or Windows
pbpaste | headroom usage --paste        # or pipe the text in yourself
headroom usage --paste --principal claude-second < panel.txt
```

It reads the session line, the all-models week and any model-scoped week, and stores each one the
way a poll would, with `source: "paste"` and `truth: "official"` (it is the vendor's own number)
at confidence 0.9:

```
ingested claude-main:all 5h 12% used, resets 14:00 (in 1h 47m)
ingested claude-main:all wk 21% used, resets Sep 13 14:00 (in 6d 23h)
ingested claude-main:fable wk 95% used, resets Sep 13 14:00 (in 6d 23h)
```

From that moment `gate`, `can`, `rate` and `route` see the Fable meter at 95% and refuse to
dispatch into it. Any panel line it cannot read is printed as a warning rather than dropped, and
the next successful poll supersedes the pasted rows simply by being newer. `--principal` is
required when more than one Claude principal is configured; `--json` prints the stored
observations.

## 5. Read a line

```sh
headroom
```

With no daemon running yet, this is a direct read: Headroom polls every configured account
itself, stores the result in `~/.headroom/headroom.db`, and prints one block per principal, for
example:

```
claude-main  claude  Max 20x  fresh 2m
  all      5h   3% used  resets in 4h 12m  HARVEST
           wk  61% used  resets in 1d 2h   CONSERVE
  fable    wk  40% used  resets in 1d 2h   CONSERVE

codex-main  codex  Plus  fresh 2m
  credits  1 available, expire Oct 5
  main     wk  81% used  resets in 1d 2h   CONSERVE

gpu-box  UP  local-27b  0 running, 0 waiting

3 principals, direct read, no daemon
```

The pace state is always the last column, so a long list reads as one column of states. Percent
bars are not drawn; colour is added only when stdout is a terminal (`--color` forces it,
`--no-color` and `NO_COLOR` turn it off).

`--verbose` (`-v`) adds an indented line under each window with the detail the default view
leaves out: the exact reset time, the burn rate against the pace that would exactly spend the
window, the protected reserve, and the reset evidence Headroom recorded.

`--plain` prints the dense one-line-per-meter form instead, which is also what you get
automatically whenever stdout is not a terminal, so existing pipelines are unchanged:

```
claude-main:all  5h 3% ↻17:10 (in 4h 12m) HARVEST | wk 61% ↻Sat 14:00 (in 1d 2h) CONSERVE  (fresh 2m)
```

`--agent` is the same form under a name that says who it is for. Agents should read `--json`
first and `--agent` second; the grouped view above is for people, and `--human` forces it in a
pipe when you want to read one.

Every window's countdown (`resets_in_seconds`/`resets_in` in `--json`, the daemon status, and the
MCP `quota_status` result) is computed fresh at response time, not stored. `headroom can` reasons
carry the same information, more tersely: `wk 61% CONSERVE, resets in 26h`.

If a meter shows UNKNOWN, that's Headroom refusing to guess, not a bug. The grouped view says why
in plain words and what to do about it, once per principal when every meter shares the reason.
See [concepts.md](concepts.md) for what freshness and UNKNOWN mean.

Antigravity is the one vendor this direct read can't fully serve: without the daemon's warm `agy`
session, a one-shot read reports why instead of guessing:

```
antigravity  antigravity  failed <1m
  gemini   5h         -                    UNKNOWN
           wk         -                    UNKNOWN
  UNKNOWN: the daemon is not running, and Antigravity needs the daemon-kept agy. Run: headroom
  install-service
```

That resolves itself once you install the daemon in the next step.

### Live dashboard

Run `headroom dashboard` (or `headroom top`) for an automatically updating terminal view.
It refreshes every 5 seconds; `--interval 2` selects the minimum interval. Every frame reads
cached data through the daemon socket with a 500 ms budget, then falls back to the store.
It never polls a vendor. Here, `direct read` means reading the local cache without an answering
daemon. Older daemons that do not support the dashboard request use their local cache and
still show `daemon fresh Ns ago`. All clocks use your local time zone.

```text
Headroom 0.1.0 | daemon fresh 0s ago | 14:00:00

Burndown: solid used, dotted plan, │ now, ░ reserve
account-a  claude  Max  fresh <1m
  all        5h  [########............]  38% ↗ resets in 2h 30m HARVEST
100%│░░░░░░░░░░░░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░░░░░⡀░⠄░⠂⠈│
    │                           │              ⡀ ⠄ ⠁       │
    │                           │      ⡀ ⠄ ⠂ ⠁             │
    │                           │⡀ ⠄ ⠁                     │
    │                    ⡀ ⠄ ⠂ ⣁⡀                          │
    │              ⡀ ⠄ ⣂⣀⠤⠤⠒⠒⠉⠉ │                          │
    │        ⠄⢀⣂⣀⠥⠤⠒⠒⠉⠉         │                          │
  0%│⣀⡠⠤⠤⠒⠒⠓⠉⠉⠁                 │                          │
08/09, 11:30                              08/09, 16:30 reset
38% used, 2h 30m left, under pace, HARVEST

EVENTS (last 8)
No events

LEASES / RESERVES / PACING
reserve account-a:all: 10%
q quit  p pause  v verbose  e events  g graphs  ? help
```

This example uses mock data. Each hard percent window gets an eight-row graph after three
distinct readings in that window. Its vertical scale is always 0 to 100% used; the dotted
plan runs from 0% at the window start to 100% at reset. Usage above that line is over even
pace. The vertical marker is now, and the shaded top band protects the configured reserve.
`--ascii` uses half blocks instead of braille dots, also selected automatically for `TERM=dumb`.

At 100 columns, the account-wide weekly meter also shows a sparkline for the last seven days
with local day ticks: `F` marks a free-reset grant or use, `!` an unscheduled reset, and `*`
both in the same column. Gaps mean no reading. A three-row wordmark appears at 100 columns
and 30 rows. Pace glyphs remain readable without colour: `●` NORMAL, `↗` HARVEST,
`⚠` CONSERVE, `🛑` FREEZE, and `?` UNKNOWN.

`g` toggles graphs to save rows, `p` pauses/resumes reads, `v` shows burn, sustainable pace,
reset evidence and idle markers, `e` widens events, `?` shows key help, and `q` exits. The
terminal is restored on exit or error. Below 80 columns the footer stacks. Short terminals
show an overflow notice. Colour requires a terminal; `NO_COLOR` or `--no-color` disables it.
`--once`, or piping stdout, prints one grouped frame and exits.

## 6. Install the daemon

```sh
headroom install-service
```

This writes a service definition (a launchd agent on macOS, a systemd user unit on Linux, a Task
Scheduler XML on Windows) and prints the command to load it. Run that printed command:

```sh
# macOS
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.headroom.daemon.plist
# Linux
systemctl --user enable --now headroom.service
```

Once it's running, `headroom` and `headroom doctor` talk to the daemon over a local socket
(`~/.headroom/headroom.sock`, mode 0600) instead of polling directly, and, by default, the daemon
keeps the Antigravity `agy` session warm between reads. See [vendors.md](vendors.md) for what that
buys you and where it still falls short. Everything the daemon logs through its own writer goes to
`~/.headroom/logs/daemon.log` (mode 0600, read with `headroom logs --tail`) and rotates itself at 5
MiB into `daemon.log.1`..`.4`; the service definition above also points the OS's raw stdout/stderr
at that same file, and Headroom does not rotate that half of the pipe, so lean on the platform's own
log rotation (`logrotate`, `newsyslog`) if a process crash ever needs to be bounded too.

## 7. Register the MCP server

```sh
claude mcp add headroom -- npx headroomd mcp
```

(swap `npx headroomd` for `node /path/to/headroom/dist/cli.js` if you're working from a source
checkout instead of the published package, same as step 1)

For every extra Claude Code profile, point at its config directory:

```sh
CLAUDE_CONFIG_DIR=~/.claude2 claude mcp add headroom -- npx headroomd mcp
```

This registers Headroom's MCP server (stdio; `quota_status`, `quota_can`, `quota_events`, and
three lease tools) for that Claude Code session. See [mcp-and-agents.md](mcp-and-agents.md) for
the full tool list and how an orchestrator should call them.

## 8. Copy the skill

```sh
mkdir -p ~/.claude/skills/headroom
cp skills/headroom/SKILL.md ~/.claude/skills/headroom/SKILL.md
```

That's the skill that tells a Claude Code orchestrator to check `headroom can` before it fans out
work and to treat UNKNOWN as no capacity, the same rule this file just described.

## Shell completions

`headroom completion <shell>` prints a completion script for `bash`, `zsh`, `fish` or `pwsh`,
covering every command, subcommand and flag `--help` knows about. Add one line to your profile:

```sh
# bash (~/.bashrc)
eval "$(headroom completion bash)"

# zsh (~/.zshrc)
eval "$(headroom completion zsh)"

# fish (~/.config/fish/config.fish)
headroom completion fish | source
```

```powershell
# PowerShell ($PROFILE)
Invoke-Expression (headroom completion pwsh | Out-String)
```

In bash and zsh, `--meter` and `--principal` also complete to the actual meter and principal ids
Headroom currently knows about (read from the daemon if it answers quickly, the local store
otherwise) rather than just the flag name.

## Windows today

Headroom's paths, the daemon transport, and the service installer all have Windows
implementations: `%LOCALAPPDATA%\headroom` (or `HEADROOM_HOME`) instead of `~/.headroom`, a named
pipe (`\\.\pipe\headroom-<username>-<home digest>`) instead of a Unix socket, and a Task Scheduler XML instead of
launchd or systemd. Claude and Codex read normally, straight from their credential files.

Antigravity is not available on Windows yet. The daemon's warm `agy` keepalive needs a POSIX
pseudo-terminal (`script`), which Windows doesn't have, and the native sensing engine that reads
that warm session isn't built for Windows either. An Antigravity principal on Windows only gets
the remote OAuth path, which Google can reject for the free Gemini Code Assist tier; see
[vendors.md](vendors.md).

CI runs lint, the full test suite and a build on `ubuntu-latest`, `windows-latest` and
`macos-latest` on every push, and every release is installed from the npm registry into a fresh
home on macOS, Linux (a Raspberry Pi 5) and Windows 11 (a VM), where a scripted run walks the
install, discovery, doctor, daemon, socket or named pipe, service install and MCP steps above.
What has not happened yet is a person using it daily on Windows with real accounts; the
daily-used environment is macOS.

## Staying up to date

`headroom` and `headroom doctor` check the npm registry at most once every 24 hours and print a
one-line notice when a newer `headroomd` is out:

```
headroomd 0.2.0 is available; run: headroom update
```

That check sends nothing but the package name -- no account identifiers, no telemetry -- and a
failed check is silent (never delays a status line; at most a debug line in `headroom logs
--tail`). Set `update_check = false` in `policy.toml` to turn it, and the network call behind it,
off entirely.

Run the update yourself:

```sh
headroom update            # installs the newer version and restarts the service, if one is running
headroom update --notes    # shows the release's changelog first, then asks before installing
headroom update --dry-run  # prints what it would do without changing anything
```

Headroom never installs an update on its own. Only `headroom update`, run by you, ever calls
`npm install -g`. The daemon never checks and never installs anything -- the check above only ever
happens from the CLI a human is looking at. This is deliberate, not an oversight: Headroom reads
credentials for every account it watches, so the one process with that access must never replace
its own binary unattended. A silent auto-update is also a silent supply-chain risk -- an update
you didn't ask for is a lot easier to slip a compromised build past than one you triggered and can
watch. Provenance on the published `headroomd` package (the same npm publish attestation every
`npm install -g headroomd@<version>` verifies) is what makes a manual update trustworthy; skipping
the manual step would skip that check too.

## Uninstall

`headroom uninstall` reverses what `setup` (and `install-service` / `claude mcp add`) did, in
order, printing each step and its result:

```sh
headroom uninstall              # stops/removes the service, removes the MCP registration
headroom uninstall --home       # also deletes the Headroom home (asks first; --yes skips the ask)
headroom uninstall --home --yes # deletes the Headroom home without asking
headroom uninstall --dry-run    # prints the plan; changes nothing
```

1. **Stops and removes the background service** -- the launchd plist, systemd user unit, or Task
   Scheduler task `install-service`/`setup` wrote, identified by the exact name Headroom itself
   gave it. A machine with no service installed reports nothing to do.
2. **Removes the Claude Code MCP registration** (`claude mcp remove headroom`) for every configured
   Claude profile that actually has one registered, setting `CLAUDE_CONFIG_DIR` for a non-default
   profile. If the `claude` executable isn't on `PATH`, the command is printed instead of run.
3. **With `--home`**, deletes the Headroom home directory: the database, logs, and config,
   including `accounts.toml` -- so that goes with it too. This step asks first (`y/N`); `--yes`
   answers yes without asking, and neither `--home` nor a plain run without it touches this
   directory. Headroom holds no macOS Keychain permission of its own to remove: it reads the
   Claude credential through `/usr/bin/security`, and the Keychain item belongs to Claude Code.
4. **Prints the npm uninstall command** -- `npm uninstall -g headroomd`. Headroom cannot remove its
   own package while it is running, so this is always left for you to run yourself.

Exits 0 on success or when there was nothing to do, 1 if any step failed.
