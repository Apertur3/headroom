import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_LIST, main } from "../src/cli.js";
import { completionCommand, completionMeterIds, generateBashScript, generateFishScript, generatePwshScript, generateZshScript } from "../src/completion.js";
import { socketPath } from "../src/daemon.js";
import { HeadroomStore } from "../src/store.js";
import { writeDiscoveredAccounts } from "../src/registry.js";
import type { Observation } from "../src/types.js";

const TOP_LEVEL_COMMANDS = [...new Set(COMMAND_LIST.map(([name]) => name.split(/\s+/)[0]))];
const GATE_FLAGS = ["--need", "--meter", "--class", "--model", "--owner", "--plan", "--plan-share", "--json"];

function escapeRegExp(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function mentionsWord(script: string, word: string): boolean { return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(script); }

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  return { logs, restore: () => spy.mockRestore() };
}

function hasBinary(name: string): boolean {
  return spawnSync("which", [name]).status === 0;
}

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "headroom-completion-"));
  temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(home); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

function fixtureObservation(meterId: string, principalId: string): Observation {
  const now = new Date().toISOString();
  return {
    principal_id: principalId, meter_id: meterId, window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: now,
    observed_at: now, fetched_at: now, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

describe("headroom completion", () => {
  it("rejects a missing or unknown shell", async () => {
    await expect(completionCommand([])).rejects.toThrow("Usage: headroom completion");
    await expect(completionCommand(["powershell"])).rejects.toThrow("Usage: headroom completion");
  });

  it("prints a script for each supported shell that mentions every command and every gate flag", async () => {
    for (const shell of ["bash", "zsh", "fish", "pwsh"] as const) {
      const { logs, restore } = captureLog();
      try { expect(await completionCommand([shell])).toBe(0); }
      finally { restore(); }
      expect(logs).toHaveLength(1);
      const script = logs[0];
      for (const name of TOP_LEVEL_COMMANDS) expect(mentionsWord(script, name)).toBe(true);
      // fish spells a long option without the leading "--" (`-l need`, not
      // `--need`); every other shell keeps the flag exactly as `gate` itself
      // takes it.
      for (const flag of GATE_FLAGS) expect(script).toContain(shell === "fish" ? flag.slice(2) : flag);
    }
  });

  it("names accounts discover, lease start|list|end, keychain grant, inbox send, plan import and engine install as subcommands", () => {
    const bash = generateBashScript();
    expect(bash).toContain("discover");
    expect(bash).toMatch(/start list end|start.*list.*end/);
    expect(bash).toContain("grant");
    expect(bash).toContain("send");
    expect(bash).toContain("import");
    expect(bash).toContain("install");
  });

  it("generates syntactically valid scripts (bash -n / zsh -n / fish -n where installed)", () => {
    const cases: Array<[string, string, () => string]> = [
      ["bash", "bash", generateBashScript],
      ["zsh", "zsh", generateZshScript],
      ["fish", "fish", generateFishScript],
    ];
    for (const [label, binary, generate] of cases) {
      if (!hasBinary(binary)) { console.log(`skipping ${label} -n syntax check: ${binary} is not installed`); continue; }
      const result = spawnSync(binary, ["-n"], { input: generate(), encoding: "utf8" });
      expect(result.status, `${label} -n reported: ${result.stderr}`).toBe(0);
    }
    // pwsh has no direct syntax-only flag; still confirmed to be well-formed
    // PowerShell by parsing it, without ever running its ScriptBlock body.
    if (hasBinary("pwsh")) {
      const script = generatePwshScript().replace(/'/g, "''");
      const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", `[void][System.Management.Automation.Language.Parser]::ParseInput('${script}', [ref]$null, [ref]$null)`]);
      expect(result.status, `pwsh parse reported: ${result.stderr?.toString()}`).toBe(0);
    } else {
      console.log("skipping pwsh parse check: pwsh is not installed");
    }
  });
});

describe("headroom _complete-meters (hidden)", () => {
  it("prints meter ids from a temporary store", async () => {
    await withHeadroomHome(async (home) => {
      const store = await HeadroomStore.open(home);
      store.insert(fixtureObservation("claude-main:all", "claude-main"));
      store.insert(fixtureObservation("codex-main:main", "codex-main"));
      store.close();
      const { logs, restore } = captureLog();
      try { expect(await main(["_complete-meters"])).toBe(0); }
      finally { restore(); }
      expect(logs.sort()).toEqual(["claude-main:all", "codex-main:main"]);
    });
  });

  it("prints nothing, and still exits 0, with no store and no daemon within the completion budget", async () => {
    await withHeadroomHome(async (home) => {
      const started = performance.now();
      const { logs, restore } = captureLog();
      try { expect(await main(["_complete-meters"])).toBe(0); }
      finally { restore(); }
      expect(logs).toEqual([]);
      await expect(lstat(join(home, "headroom.db"))).rejects.toMatchObject({ code: "ENOENT" });
      // The helper's deadline is 200ms. Leave room for a loaded Windows CI
      // worker to schedule the timer, while still catching the old 5s pipe
      // handle leak that made this test impossible to run there.
      expect(performance.now() - started).toBeLessThan(800);
    });
  });

  it("cancels a stalled daemon socket when its completion deadline expires", async () => {
    await withHeadroomHome(async (home) => {
      let clientClosed!: () => void;
      const closed = new Promise<void>((resolve) => { clientClosed = resolve; });
      let client: Socket | undefined;
      const server = createServer((socket) => {
        // Deliberately never answer: completionMeterIds must abort the client
        // connection itself instead of merely returning while its socket keeps
        // the process alive. This is a real named-pipe listener on Windows.
        client = socket;
        // A net.Socket starts paused. Consume the health request so the
        // client can finish its shutdown handshake instead of leaving this
        // deliberately unresponsive test server with a paused read buffer.
        socket.resume();
        socket.once("close", clientClosed);
      });
      try {
        await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath(home), resolve));
      } catch (error: unknown) {
        // Some restricted test sandboxes forbid Unix-socket bind(2). Windows
        // CI uses a named pipe here and exercises the real regression path.
        if ((error as NodeJS.ErrnoException).code === "EPERM") { console.log("skipping stalled completion socket check: sandbox forbids listen(2)"); return; }
        throw error;
      }
      try {
        const started = performance.now();
        await expect(completionMeterIds(30)).resolves.toEqual([]);
        expect(performance.now() - started).toBeLessThan(300);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("completion left its stalled daemon socket open")), 300);
          closed.then(() => { clearTimeout(timer); resolve(); });
        });
      } finally {
        // If an assertion above failed, do not let the test fixture's open
        // client conceal the original failure by hanging server.close().
        client?.destroy();
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});

describe("headroom _complete-principals (hidden)", () => {
  it("prints principal ids from a temporary accounts.toml", async () => {
    await withHeadroomHome(async () => {
      await writeDiscoveredAccounts([
        { name: "claude-main", vendor: "claude", location: "/tmp/does-not-matter", adapter: "native-ts" },
        { name: "codex-main", vendor: "codex", location: "/tmp/does-not-matter", adapter: "native-ts" },
      ]);
      const { logs, restore } = captureLog();
      try { expect(await main(["_complete-principals"])).toBe(0); }
      finally { restore(); }
      expect(logs.sort()).toEqual(["claude-main", "codex-main"]);
    });
  });
});
