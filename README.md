# Tally

**Your agents know their budget.** Tally is a local daemon plus CLI and MCP tool that reports the
remaining 5-hour and weekly capacity of every AI subscription and account you own, remembers
resets and free-reset grants, and turns that into pace states an orchestrator can act on.

Status: pre-alpha, being built in slices. See `docs/spec.md`.

- Multiple accounts per vendor from day one (two Claude Max plans, three Codex homes, ...).
- Pools, not vendors: one Google account carries separate Gemini and Claude/GPT meters.
- Sensing delegated to [CodexBar](https://github.com/steipete/codexbar) (MIT) as a pinned engine,
  plus a native Claude adapter that reads the macOS Keychain per config dir.
- Tokens are never written to disk or logs. See `SECURITY.md`.
- Ships an orchestrator skill: capability routing stays yours, Tally only filters by budget.

Package name: `keeptally` (npm). Brand: Tally.

## Daemon and agent access

Start the local daemon with `tally daemon`; it owns `~/.tally/tally.db` and serves
private JSON-RPC on `~/.tally/tally.sock`. Without it, the CLI performs a one-shot
direct read and marks that output `(direct read, no daemon)`.

Add the MCP server to each Claude profile:

```sh
claude mcp add tally -- npx keeptally mcp
CLAUDE_CONFIG_DIR=~/.claude2 claude mcp add tally -- npx keeptally mcp
```

Codex and agy agents call the same CLI directly: `tally can <action-class>` before
dispatching, `tally --json` for current meters, and `tally events --since 24h` for changes.
Use `tally install-service` to write (but not load) the launchd/systemd user service; it prints
the exact `launchctl` or `systemctl` command to run yourself.
