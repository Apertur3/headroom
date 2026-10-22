import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { observeClaude } from "../src/adapters/claude.js";
import { observeCodex } from "../src/adapters/codex.js";

const FORBIDDEN_HEADERS = ["originator", "x-xai-token-auth", "x-msh-platform", "origin", "referer"];
const at = new Date("2026-09-03T17:26:36Z");

function recorder(): { fetch: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  return { requests, fetch: (async (input: Request) => { requests.push(input); return new Response("{}", { status: 500 }); }) as unknown as typeof fetch };
}
const expectHonest = (request: Request): void => {
  expect(request.headers.get("user-agent")).toMatch(/^headroomd\/\d+\.\d+\.\d+/);
  for (const name of FORBIDDEN_HEADERS) expect(request.headers.get(name), name).toBeNull();
};

describe("honest client identity", () => {
  it("Claude usage request", async () => {
    const { fetch, requests } = recorder();
    await observeClaude({ name: "claude-main", vendor: "claude", location: "/nonexistent/.claude", adapter: "native-ts" }, {
      platform: "linux", now: () => at, fetch,
      readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: at.getTime() + 60_000 } }),
    });
    expect(requests).toHaveLength(1);
    expectHonest(requests[0]);
  });

  it("Codex usage and reset-credit requests", async () => {
    const { fetch, requests } = recorder();
    await observeCodex({ name: "codex-main", vendor: "codex", location: "/nonexistent/.codex", adapter: "native-ts" }, {
      now: () => at, fetch, readFile: async () => JSON.stringify({ tokens: { access_token: "t", expires_at: at.getTime() + 60_000 } }),
    });
    expect(requests).toHaveLength(2);
    requests.forEach(expectHonest);
  });

  it("no source file or shipped probe names another client's identity", async () => {
    const forbidden = /claude-code\/\d|"CodexBar"|Codex Desktop|xai-grok-cli|kimi_code_cli/;
    const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]))).flat();
    for (const file of [...await walk("src"), "engine/Sources/HeadroomClaudeProbe/HeadroomClaudeProbe.swift"]) {
      expect(forbidden.test(await readFile(file, "utf8")), file).toBe(false);
    }
  });
});
