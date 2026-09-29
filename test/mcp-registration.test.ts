import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_KEYCHAIN_INACCESSIBLE_REASON, claudeSecurityToolFailureReason, isClaudeKeychainInaccessibleReason } from "../src/adapters/claude.js";
import { credentialCheck, mcpRegistrationCheck, mcpRegistrationFor } from "../src/doctor.js";
import { CLAUDE_MCP_ADD_ARGS, MCP_ADD_COMMAND } from "../src/mcp-registration.js";
import type { Account } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

// A non-default profile directory keeps every read inside the temp dir: its .claude.json sits
// inside it, so the real ~/.claude.json is never opened.
async function profile(config: unknown): Promise<Account> {
  const location = await mkdtemp(join(tmpdir(), "headroom-mcp-scope-")); temporary.push(location);
  await mkdir(location, { recursive: true });
  await writeFile(join(location, ".claude.json"), JSON.stringify(config));
  return { name: "claude-test", vendor: "claude", location, adapter: "native-ts" };
}

const server = { command: "headroom", args: ["mcp"] };

describe("MCP registration scope", () => {
  it("registers at user scope, and the command setup runs is the command it prints", () => {
    expect(MCP_ADD_COMMAND).toBe("claude mcp add --scope user headroom -- headroom mcp");
    expect(CLAUDE_MCP_ADD_ARGS).toEqual(["mcp", "add", "--scope", "user", "headroom", "--", "headroom", "mcp"]);
    expect(`claude ${CLAUDE_MCP_ADD_ARGS.join(" ")}`).toBe(MCP_ADD_COMMAND);
  });

  it("doctor treats a user-scope entry as registered", async () => {
    const account = await profile({ mcpServers: { headroom: server } });
    expect(await mcpRegistrationFor(account.location)).toEqual({ user: true, localDirectories: [] });
    const result = await mcpRegistrationCheck([account]);
    expect(result).toMatchObject({ level: "OK", detail: "registered for claude-test" });
  });

  it("doctor warns about a local-scope-only entry, names the directory it is bound to, and fixes it at user scope", async () => {
    const account = await profile({ projects: { "/work/some-project": { mcpServers: { headroom: server } }, "/work/other": { mcpServers: { unrelated: server } } } });
    const result = await mcpRegistrationCheck([account]);
    expect(result?.level).toBe("WARN");
    expect(result?.detail).toContain("/work/some-project");
    expect(result?.detail).not.toContain("/work/other");
    expect(result?.fix).toContain("claude mcp add --scope user headroom -- headroom mcp");
  });

  it("doctor still reports a profile with no entry anywhere as not registered", async () => {
    const account = await profile({ mcpServers: { unrelated: server } });
    expect(await mcpRegistrationCheck([account])).toMatchObject({ level: "INFO", detail: "registered for none; not registered for claude-test" });
  });
});

describe("Claude read exit 36 (keychain not accessible from this session)", () => {
  it("maps security exit 36 to guidance instead of a bare exit number", () => {
    const reason = claudeSecurityToolFailureReason("exit=36");
    expect(reason).toBe(CLAUDE_KEYCHAIN_INACCESSIBLE_REASON);
    expect(reason).toContain("not accessible from this session");
    expect(reason).toContain("security unlock-keychain");
    expect(isClaudeKeychainInaccessibleReason(reason)).toBe(true);
    // Any other status keeps the plain wording.
    expect(claudeSecurityToolFailureReason("exit=44")).toBe("the macOS security tool could not read the credential (exit 44)");
  });

  it.skipIf(process.platform !== "darwin")("doctor does not call the credential OK when the last live read hit it", async () => {
    const store = { latest: () => ({ freshness: "failed", reason: CLAUDE_KEYCHAIN_INACCESSIBLE_REASON }), audit: () => undefined };
    const account: Account = { name: "claude-test", vendor: "claude", location: "/nonexistent/.claude-test", adapter: "native-ts" };
    const result = await credentialCheck(account, new Map(), store as never);
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain("not accessible from this session");
    expect(result.fix).toContain("security unlock-keychain");
  });
});
