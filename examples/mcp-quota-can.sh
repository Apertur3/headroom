#!/usr/bin/env bash
# What an MCP client sends: initialize, then one `quota_can` tool call. This
# talks to `headroom mcp` over stdio the way Claude Code does.
#
# Try it against synthetic data:
#   npm run build
#   eval "$(node scripts/demo-home.mjs)"
#   bash examples/mcp-quota-can.sh
#
# To register the server in Claude Code instead:
#   claude mcp add --scope user headroom -- headroom mcp
set -euo pipefail

HEADROOM="${HEADROOM:-headroom}"
CLASS="${CLASS:-codex-build}"

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"example","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"quota_can\",\"arguments\":{\"action_class\":\"${CLASS}\",\"owner\":\"example\"}}}" \
  | "$HEADROOM" mcp | tail -n 1
