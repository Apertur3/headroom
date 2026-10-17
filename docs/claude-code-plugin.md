# Claude Code plugin

The Headroom plugin includes the Headroom skill, a `headroom mcp` stdio server registration
and a `UserPromptSubmit` hook that reads the daemon's cached quota line with its age.
The hook makes no network calls and always exits successfully. It requires a POSIX shell;
Windows plugin hooks are not supported yet.

## Install

Install headroomd first, with Node 22.13 or newer or Homebrew:

```sh
npm install -g headroomd   # or: brew install apertur3/tap/headroom
headroom setup
claude plugin marketplace add Apertur3/headroom
claude plugin install headroom@headroom
```

Keep the installed `headroom` command on the PATH Claude Code uses. The plugin registers
the MCP server and quota hook automatically; no separate registration is needed.

When both headroomd and the cached line are missing, each prompt prints:

```text
[Headroom] plugin needs headroomd: npm install -g headroomd, then headroom setup (https://github.com/Apertur3/headroom#install)
```

If headroomd is installed but the daemon has not written a line yet, the hook stays silent.

## One quota line per prompt

The plugin checks existing `settings.json` files under `CLAUDE_CONFIG_DIR`, `~/.claude` and
`~/.claude2` for `hooks/claude-line.sh`, the script installed by `headroom hook install`.
When found, the plugin stays silent and lets that hook print the quota line. You can keep
both installed without doubling the line. The plugin does not edit your settings files.

## Uninstall

```sh
claude plugin uninstall headroom@headroom
claude plugin marketplace remove headroom
```

This removes the plugin's skill, MCP registration and hook. A separately installed
`headroom hook install` hook remains; remove it with `headroom hook uninstall --agent claude`
if you no longer want it. headroomd remains installed.

## MCP Registry

The official MCP Registry name is `io.github.Apertur3/headroom`, backed by the npm package
`headroomd`. Clients run its `headroom` command with the `mcp` argument over stdio.
See [MCP tools and examples](mcp-and-agents.md) for usage.
