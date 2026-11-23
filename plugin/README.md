# Headroom for Claude Code

This plugin adds the Headroom skill: before Claude starts a job, spawns agents or picks a subscription, it asks
Headroom how much of each AI subscription (Claude, Codex, Gemini and others) is left and whether the job fits.

The skill runs the `headroom` command on your computer. It does not install it: install Headroom first by
following https://github.com/Apertur3/headroom#install, then ask Claude to "set up headroom".

What the skill runs: `headroom` read commands (`headroom --json`, `can`, `gate`, `rate`, `plan` and similar), and
`headroom doctor` plus the commands it names only when you ask Claude to set Headroom up. Headroom reads usage
with your own logged-in tools; it keeps no credentials of its own and sends nothing to a server of ours. See
https://github.com/Apertur3/headroom/blob/master/SECURITY.md.

The full plugin, with the quota line before each prompt and the MCP tools, installs from the repository's own
marketplace: `/plugin marketplace add Apertur3/headroom`.

MIT licensed.
