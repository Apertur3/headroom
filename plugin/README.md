# Headroom for Claude Code

This plugin adds the Headroom skill: before Claude starts a job, spawns agents or picks a subscription, it asks
Headroom how much of each AI subscription (Claude, Codex, Gemini and others) is left and whether the job fits.

The skill runs the `headroom` command on your computer. It does not install it: install Headroom first by
following https://github.com/Apertur3/headroom#install, then ask Claude to "set up headroom".

What the skill runs: `headroom` read commands (`headroom --json`, `can`, `gate`, `rate`, `plan` and similar), and
`headroom doctor` plus the commands it names only when you ask Claude to set Headroom up. Headroom reads usage
with your own logged-in tools; it keeps no credentials of its own and sends nothing to a server of ours. See
https://github.com/Apertur3/headroom/blob/master/SECURITY.md.

MIT licensed.

## Privacy

This plugin is a skill: it sends nothing anywhere itself. It runs the `headroom` command on your computer and reads
its output. What Headroom handles:

- **Reads:** your usage and plan limits (percent used, reset times, plan name) from the AI tools you are signed in to
  on this computer. It uses each tool's own existing login at the moment of the request and drops it afterwards; it
  keeps no credentials of its own and redacts tokens, cookies and, by default, email addresses from its output.
- **Sends:** read-only usage requests to the vendors you configured (for example Anthropic, OpenAI, Google), with your
  own login, identified as `headroomd/<version>`. No prompts, no files, no account changes. Notifications go only to
  channels you set up yourself. A once-a-day npm version check carries no account data (`update_check = false` turns
  it off). No telemetry, no analytics, and nothing goes to a server run by the Headroom project.
- **Keeps:** a history of usage readings in a local database on your computer (under `~/.headroom` by default), so it can show
  trends and pace. You can delete it at any time. Nothing is kept anywhere else.

Full details: https://github.com/Apertur3/headroom#vendor-endpoints-and-your-accounts and
https://github.com/Apertur3/headroom/blob/master/SECURITY.md.
