# Quickstart

Five minutes from install to a line of output you can trust, on macOS or Linux. Windows steps
are noted separately at the end.

## 1. Install

Headroom is on npm as `headroomd` and needs Node 22.13 or newer.

```sh
npm install -g headroomd
headroom version
```

`npx headroomd <command>` works without installing, but the daemon, the MCP registration and
the service installer all expect a `headroom` command on your PATH, so the global install is the
one this walkthrough assumes. To work from source instead, clone the repository, run
`npm install && npm run build`, and use `node dist/cli.js` where the steps say `headroom`.

## Or run `headroom setup`

`headroom setup` does sections 2 through 7 below for you, one step at a time: it prints what
each step is about to do, asks a yes/no question before anything that changes something, and
skips the Keychain dialog and the MCP registration if you say no. `--dry-run` shows the whole
plan without changing anything; `--yes` answers yes to every step except the Keychain grant,
which it never runs on its own -- it prints the command for you to run yourself instead;
`--skip-service` and `--skip-mcp` leave those two steps out entirely. The sections below are
still the explanation of what each step does and why; read them if you want the detail, or if
something `setup` reports needs a closer look.

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
1. headroom keychain grant
2. headroom install-service
3. claude mcp add headroom -- npx headroomd mcp
```

(step 1 only appears on macOS). Run `headroom --help` any time for the full command list, or
`headroom <command> --help` for one command's usage.

## 4. Grant Keychain access (macOS only)

```sh
headroom keychain grant
```

Claude Code stores its OAuth token in the macOS Keychain, under the service name
`Claude Code-credentials` for `~/.claude`, or `Claude Code-credentials-<8 hex characters>` for any
other config directory. Headroom never reads that token itself: it runs a small binary,
`headroom-claude-probe`, which reads the Keychain item and makes the usage request in the same
process, so the token never reaches Node or stdout. That binary is built by
`scripts/build-probe.sh` (a universal macOS binary, verified against a recorded SHA-256 before
every use) and, by default, signed under a **stable local identity** named "Headroom Local" that
`build-probe.sh` creates once in your login keychain and reuses for every later build. This is why
a rebuild -- a new headroomd version, `npm run engine:build`, `npm pack`, `release:check` -- does
not ask for the Keychain dialog again: every build after the first is signed under the exact same
identity, so macOS still recognizes it as the same signer. The tradeoff is one extra one-time
dialog the first time `build-probe.sh` ever runs on a machine (creating that identity touches the
login keychain); after that, `headroom keychain grant` triggers one macOS Keychain access dialog
for the probe itself, and that grant survives every rebuild from then on. Choose Always Allow so
future polls don't prompt again. Set `HEADROOM_CODESIGN_IDENTITY` to sign with a different identity
instead (a real Developer ID, once this ships past beta); if creating the local identity fails for
any reason, `build-probe.sh` falls back to ad-hoc signing with a printed warning, and every rebuild
after that will ask again, the same as headroomd versions before this one. Headroom also only ever
uses the exact probe binary a grant actually succeeded under (see doctor's "claude probe binary"
line) -- a second candidate appearing later (a repo checkout built alongside an existing global
install, say) is reported, never silently substituted. If you run more than one Claude Code
profile, repeat the grant once per profile:

```sh
headroom keychain grant --principal claude-2
```

If a config dir has no Claude Code login at all yet, `keychain grant` says so instead of popping a
dialog for nothing:

```
no Claude login for /Users/you/.claude2; run: CLAUDE_CONFIG_DIR=/Users/you/.claude2 claude, or remove this principal from accounts.toml
```

Running `keychain grant` from a sandboxed or remote shell (an agent's own shell, not a Terminal
window) is a different, and more common, failure: macOS refuses to show the Keychain access dialog
at all there, even when doctor already confirms the Keychain item is present. Headroom distinguishes
this from "no login" and says so plainly:

```
claude-main: the Keychain dialog cannot be shown from this shell; run this command in your own Terminal
```

On Linux and Windows there's no Keychain step: Headroom reads the token straight from
`<config-dir>/.credentials.json`.

## 4b. Or skip the Keychain dialog entirely: `headroom statusline`

Claude Code hands its `statusLine` command a JSON object on every prompt render, containing
`rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at`) -- the exact
numbers `keychain grant` and the vendor probe exist to fetch, already sitting on stdin for free.
Register `headroom statusline` as that command and Headroom reads it as a zero-auth source instead:

```json
{
  "statusLine": { "type": "command", "command": "headroom statusline" }
}
```

Add this to `~/.claude/settings.json` for the default profile, or `<CLAUDE_CONFIG_DIR>/settings.json`
for any other profile (e.g. `~/.claude2/settings.json` for `claude-2`) -- one line per profile,
same as `keychain grant --principal`. Claude Code only supports one `statusLine` command; if you
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

Every reading this way snapshots to `~/.headroom/statusline/<profile>.json` (0600); the collector
prefers a snapshot under 10 minutes old over the vendor probe, and reads a Fable-scoped or other
model-scoped bucket the same way if Claude Code ever includes one in `rate_limits`. **This removes
the macOS Keychain dialog entirely for a profile set up this way** -- no `headroom keychain grant`
ever needed for it, since Headroom never has to open the Keychain item itself. A profile whose
statusline hasn't rendered yet (or has gone stale) still falls back to the probe, subject to the
usual grant gate.

## 4c. When the meter is blocked, paste the panel

Some readings only ever exist on screen: a probe the operator has not granted, a machine where the
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
itself, stores the result in `~/.headroom/headroom.db`, and prints one line per meter, for
example:

```
claude-main:all  5h 3% ↻17:10 (in 4h 12m) HARVEST | wk 61% ↻Sat 14:00 (in 26h 18m) CONSERVE  (fresh 2m)
```

Every window's countdown (`resets_in_seconds`/`resets_in` in `--json`, the daemon status, and the
MCP `quota_status` result) is computed fresh at response time, not stored. `headroom can` reasons
carry the same information, more tersely: `wk 61% CONSERVE, resets in 26h`.

If a meter shows UNKNOWN, that's Headroom refusing to guess, not a bug. See
[concepts.md](concepts.md) for what freshness and UNKNOWN mean.

Antigravity is the one vendor this direct read can't fully serve: without the daemon's warm `agy`
session, a one-shot read reports why instead of guessing:

```
antigravity:gemini  5h UNKNOWN (no daemon; Antigravity needs the daemon-kept agy: run headroom install-service) | ...
```

That resolves itself once you install the daemon in the next step.

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
buys you and where it still falls short.

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
