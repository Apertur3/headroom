/** The one registration command, shared by setup, doctor and the docs. User scope, so the tools
 * exist in every directory rather than only the one setup happened to run from. Kept in its own
 * module because doctor and setup import each other through update.ts. */
export const MCP_ADD_COMMAND = "claude mcp add --scope user headroom -- headroom mcp";

/** MCP_ADD_COMMAND minus the leading `claude`, as an argument vector, so the command shown and the command run cannot drift. */
export const CLAUDE_MCP_ADD_ARGS = MCP_ADD_COMMAND.split(" ").slice(1);
