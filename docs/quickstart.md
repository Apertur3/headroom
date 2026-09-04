# Quickstart

Five minutes from a clone to a line of output you can trust, on macOS or Linux. Windows steps
are noted separately at the end; that platform is verified by CI, not yet by a person running it
against real accounts.

## 1. Clone and build

Headroom isn't on npm yet.

```sh
git clone https://github.com/Apertur3/headroom.git
cd headroom
npm install
npm run build
```

The commands below say `npx headroomd`. Until the first npm release, run `node dist/cli.js`
instead, or alias it for the rest of this walkthrough:

```sh
alias headroom="node dist/cli.js"
```

## 2. Find your accounts

```sh
headroom accounts discover
```

This scans your home directory for `~/.claude*` and `~/.codex*` directories and an Antigravity
CLI install, writes what it finds to `~/.headroom/accounts.toml` (mode 0600), and prints the same
TOML to stdout so you can check it before trusting it. Rename entries, drop ones you don't want
polled, or add a local inference pool by hand; `examples/accounts.toml` shows the shape, including
the commented-out `local` block for a vLLM or llama.cpp box.

## 3. Check the installation

```sh
headroom doctor
```

A read-only diagnostic: principals configured, credential files or Keychain items present, the
sensing engine's hash, the daemon socket, the Antigravity `agy` keepalive, and
`policy.toml`/`routing.toml`. Nothing it checks reads a token's contents. Fix anything marked
FAIL before continuing; WARN lines are fine to leave for now.

## 4. Grant Keychain access (macOS only)

```sh
headroom keychain grant
```

Claude Code stores its OAuth token in the macOS Keychain, under the service name
`Claude Code-credentials` for `~/.claude`, or `Claude Code-credentials-<8 hex characters>` for any
other config directory. Headroom never reads that token itself: it runs a small signed binary,
`headroom-claude-probe`, which reads the Keychain item and makes the usage request in the same
process, so the token never reaches Node or stdout. Running `headroom keychain grant` triggers one
macOS Keychain access dialog for that probe; choose Always Allow so future polls don't prompt
again. If you run more than one Claude Code profile, repeat this once per profile:

```sh
headroom keychain grant --principal claude-2
```

An updated probe binary is a new signing identity to Keychain and will ask again once. On Linux
and Windows there's no Keychain step: Headroom reads the token straight from
`<config-dir>/.credentials.json`.

## 5. Read a line

```sh
headroom
```

With no daemon running yet, this is a direct read: Headroom polls every configured account
itself, stores the result in `~/.headroom/headroom.db`, and prints one line per meter, for
example:

```
claude-main:all  5h 3% ↻17:10 HARVEST | wk 61% ↻Sat 14:00 CONSERVE  (fresh 2m)
```

If a meter shows UNKNOWN, that's Headroom refusing to guess, not a bug. See
[concepts.md](concepts.md) for what freshness and UNKNOWN mean.

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

(swap `npx headroomd` for `node /path/to/headroom/dist/cli.js`, same as above, until the npm
release)

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
pipe (`\\.\pipe\headroom-<username>`) instead of a Unix socket, and a Task Scheduler XML instead of
launchd or systemd. Claude and Codex read normally, straight from their credential files.

Antigravity is not available on Windows yet. The daemon's warm `agy` keepalive needs a POSIX
pseudo-terminal (`script`), which Windows doesn't have, and the native sensing engine that reads
that warm session isn't built for Windows either. An Antigravity principal on Windows only gets
the remote OAuth path, which Google can reject for the free Gemini Code Assist tier; see
[vendors.md](vendors.md).

All of this is verified by CI (`ubuntu-latest`, `windows-latest`, `macos-latest`, in
`.github/workflows/ci.yml`) on every push: lint, the full test suite, and a build. It has not yet
been run by a person against a real Windows machine with real accounts; the daily-verified
environment described in the README's Status section is macOS only.
