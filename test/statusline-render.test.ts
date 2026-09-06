import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { COMPACT_MAX_WIDTH, DAEMON_BUDGET_MS, daemonRows, parseRenderOptions, renderStatusline, type StatuslineContext } from "../src/statusline-render.js";
import { defaultPolicy } from "../src/policy.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
const servers: Server[] = [];
const accepted: Socket[] = [];
afterEach(async () => {
  // Every accepted connection is torn down before close(), which otherwise
  // waits on the silent sockets this suite deliberately leaves hanging.
  for (const socket of accepted.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

/** Same shape as test/statusline-cli.test.ts: main() attaches its stdin
 * listeners synchronously, so emitting right after the call starts is safe. */
async function runStatusline(argv: string[], stdin: string): Promise<{ code: number; stdout: string[] }> {
  const stdout: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => { stdout.push(line); });
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });
  try {
    const promise = main(["statusline", ...argv]);
    process.stdin.emit("data", stdin);
    process.stdin.emit("end");
    const code = await promise;
    return { code, stdout };
  } finally { logSpy.mockRestore(); writeSpy.mockRestore(); }
}

const HOUR = 3_600_000;
/** A cushion on the 5h reset so the countdown still rounds to a whole "2h"
 * however many milliseconds the run itself takes. */
const CUSHION = 30_000;
const DAY = 24 * HOUR;

function percentRow(principal: string, meter: string, minutes: number, used: number, resetsAt: Date, now: Date): Observation {
  return {
    principal_id: principal, meter_id: `${principal}:${meter}`,
    window: { kind: "fixed", minutes, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" },
    resets_at: resetsAt.toISOString(), observed_at: now.toISOString(), fetched_at: now.toISOString(),
    source: "fixture", truth: "official", freshness: "fresh", confidence: 1,
    adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

/**
 * One fixed scenario, seeded into a temporary home: a Claude session sitting
 * on pace, a Fable bucket barely touched, and a Codex account well behind its
 * weekly line. The percentages and reset offsets are chosen so the session's
 * own windows land on NORMAL and Codex's lands on CONSERVE, which is what the
 * "state only when it is not NORMAL" rule is read against.
 */
async function seedHome(root: string, now: Date): Promise<{ home: string; payload: string }> {
  const home = join(root, ".headroom");
  const store = await HeadroomStore.open(home);
  try {
    // 5h at 55% with two hours left: 60% of the window elapsed, so the
    // straight-line surplus is inside the grace band -> NORMAL.
    store.insert(percentRow("claude-main", "all", 300, 55, new Date(now.getTime() + 2 * HOUR + CUSHION), now));
    // Weekly at 12% with 6.2 days left: 11% elapsed -> NORMAL.
    store.insert(percentRow("claude-main", "all", 10_080, 12, new Date(now.getTime() + 6.2 * DAY), now));
    // Fable barely started, still inside the window's grace period -> NORMAL.
    store.insert(percentRow("claude-main", "fable", 10_080, 0, new Date(now.getTime() + 6.5 * DAY), now));
    // Codex at 83% halfway through its week -> CONSERVE.
    store.insert(percentRow("codex", "all", 10_080, 83, new Date(now.getTime() + 3.5 * DAY), now));
  } finally { store.close(); }
  await writeFile(join(home, "accounts.toml"), [
    '[[accounts]]', 'name = "claude-main"', 'vendor = "claude"', 'location = "~/.claude"', 'adapter = "native-ts"',
    '[[accounts]]', 'name = "codex"', 'vendor = "codex"', 'location = "~/.codex"', 'adapter = "native-ts"', '',
  ].join("\n"));
  await writeFile(join(home, "policy.toml"), ['[reserve]', '"claude-main:all" = 10', ''].join("\n"));
  const seconds = (offsetMs: number): number => Math.floor((now.getTime() + offsetMs) / 1000);
  const payload = JSON.stringify({
    session_id: "fixed", model: { display_name: "Sonnet" },
    rate_limits: {
      five_hour: { used_percentage: 55, resets_at: seconds(2 * HOUR + CUSHION) },
      seven_day: { used_percentage: 12, resets_at: seconds(6.2 * DAY) },
      fable_week: { used_percentage: 0, resets_at: seconds(6.5 * DAY) },
    },
  });
  return { home, payload };
}

/** Strips ANSI so a rendered line can be measured and matched as text. */
function plain(text: string): string { return text.replace(/\u001b\[[0-9;]*m/g, ""); }

describe("headroom statusline --render", () => {
  it("combines the session's own payload numbers with Headroom's other principals, in one compact line under the width budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "hr-compact-")); temporary.push(root);
    const now = new Date();
    const { home, payload } = await seedHome(root, now);
    await withHeadroomHome(home, async () => {
      const { code, stdout } = await runStatusline(["--render"], payload);
      expect(code).toBe(0);
      const line = stdout.join("");
      expect(line.split("\n").filter(Boolean)).toHaveLength(1);
      // The session's own two windows, exactly as Claude Code reported them.
      expect(line).toContain("5h 55% ↻2h");
      expect(line).toContain("wk 12%");
      // Headroom's half: the model-scoped bucket, and the other principal
      // with its own window label, percentage and pace state.
      expect(line).toContain("fable 0%");
      expect(line).toContain("codex wk 83% CONSERVE");
      // The protected reserve on the session's own meter, from policy.toml.
      expect(line).toContain("reserve 10%");
      expect(line.length).toBeLessThan(COMPACT_MAX_WIDTH);
    });
  });

  it("prints a pace state only for a window that is not NORMAL", async () => {
    const root = await mkdtemp(join(tmpdir(), "hr-pace-")); temporary.push(root);
    const now = new Date();
    const { home, payload } = await seedHome(root, now);
    await withHeadroomHome(home, async () => {
      const { stdout } = await runStatusline(["--render"], payload);
      const line = stdout.join("");
      expect(line).not.toContain("NORMAL");
      // The two NORMAL segments carry their numbers and nothing else.
      expect(line).toMatch(/5h 55% ↻2h ·/);
      expect(line).toMatch(/wk 12% ·/);
      // The one segment that is not NORMAL says so.
      expect(line).toContain("CONSERVE");
    });
  });

  it("adds burn and time-to-stall in full style", async () => {
    const root = await mkdtemp(join(tmpdir(), "hr-full-")); temporary.push(root);
    const now = new Date();
    const { home, payload } = await seedHome(root, now);
    const store = await HeadroomStore.open(home);
    // A second, older sample for the session's 5h window gives it a burn rate
    // and therefore a time to stall; one sample alone never does.
    try { store.insert(percentRow("claude-main", "all", 300, 25, new Date(now.getTime() + 2 * HOUR + CUSHION), new Date(now.getTime() - HOUR / 2))); }
    finally { store.close(); }
    await withHeadroomHome(home, async () => {
      const { stdout } = await runStatusline(["--render", "--style", "full"], payload);
      const line = stdout.join("");
      expect(line).toMatch(/5h 55% ↻2h burn \d+(\.\d)?%\/h, stall in /);
    });
  });

  it("narrows the Headroom half to --meters, keeping the session's own windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "hr-meters-")); temporary.push(root);
    const now = new Date();
    const { home, payload } = await seedHome(root, now);
    await withHeadroomHome(home, async () => {
      const { stdout } = await runStatusline(["--render", "--meters", "codex"], payload);
      const line = stdout.join("");
      expect(line).toContain("5h 55%");
      expect(line).toContain("codex wk 83%");
      expect(line).not.toContain("fable");
    });
  });

  it("emits no ANSI when stdout is not a TTY, and colours the pace state with --color", async () => {
    const root = await mkdtemp(join(tmpdir(), "hr-color-")); temporary.push(root);
    const now = new Date();
    const { home, payload } = await seedHome(root, now);
    await withHeadroomHome(home, async () => {
      const bare = await runStatusline(["--render"], payload);
      expect(bare.stdout.join("")).not.toContain("\u001b[");
      const colored = await runStatusline(["--render", "--color"], payload);
      expect(colored.stdout.join("")).toContain("\u001b[33mCONSERVE\u001b[0m");
    });
  });

  it("--chain prints the chained command's output first, then Headroom's own line", async () => {
    const root = await mkdtemp(join(tmpdir(), "hr-chain-")); temporary.push(root);
    const now = new Date();
    const { home, payload } = await seedHome(root, now);
    const echoScript = join(root, "echo-stdin.mjs");
    await writeFile(echoScript, [
      "let data = \"\";",
      "process.stdin.setEncoding(\"utf8\");",
      "process.stdin.on(\"data\", (chunk) => { data += chunk; });",
      "process.stdin.on(\"end\", () => process.stdout.write(`CHAINED:${data.length}`));",
    ].join("\n"));
    await withHeadroomHome(home, async () => {
      const { code, stdout } = await runStatusline(["--render", "--chain", process.execPath, echoScript], payload);
      expect(code).toBe(0);
      const output = stdout.join("");
      expect(output.startsWith(`CHAINED:${payload.length}\n`)).toBe(true);
      expect(output.indexOf("CHAINED:")).toBeLessThan(output.indexOf("5h 55%"));
      expect(output).toContain("codex wk 83% CONSERVE");
    });
  });

  it.skipIf(process.platform === "win32")("gives up on a daemon that never answers within the budget, and renders from the store instead", async () => {
    const root = await mkdtemp(join(tmpdir(), "hr-budget-")); temporary.push(root);
    const now = new Date();
    const { home, payload } = await seedHome(root, now);
    // A socket that accepts the connection and then says nothing at all, for
    // as long as anyone is willing to wait.
    const server = createServer((socket) => { accepted.push(socket); /* and then nothing, ever */ });
    server.unref();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(home, "headroom.sock"), resolve));

    const startedAt = Date.now();
    const rows = await daemonRows(join(home, "headroom.sock"), DAEMON_BUDGET_MS);
    const elapsed = Date.now() - startedAt;
    expect(rows).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(DAEMON_BUDGET_MS - 20);
    expect(elapsed).toBeLessThan(1500);

    await withHeadroomHome(home, async () => {
      const renderStartedAt = Date.now();
      const { code, stdout } = await runStatusline(["--render"], payload);
      expect(code).toBe(0);
      expect(Date.now() - renderStartedAt).toBeLessThan(3000);
      // The store answered where the daemon did not.
      expect(stdout.join("")).toContain("codex wk 83% CONSERVE");
    });
  });
});

describe("renderStatusline", () => {
  const context = (observations: Observation[]): StatuslineContext => ({ observations, leases: [], policy: defaultPolicy, principal: "claude-main", source: "store" });

  it("drops the least important segments and counts them when the compact line would overflow", () => {
    const now = new Date();
    const many = Array.from({ length: 14 }, (_, index) =>
      percentRow(`principal-number-${index}`, "all", 10_080, 40 + index, new Date(now.getTime() + 3.5 * DAY), now));
    const line = renderStatusline(
      { profile: "default", observed_at: Math.floor(now.getTime() / 1000), five_hour: { used_percent: 55, resets_at: null }, seven_day: { used_percent: 12, resets_at: null }, extra: {} },
      context(many), { style: "compact", meters: [], color: false }, now);
    expect(plain(line).length).toBeLessThan(COMPACT_MAX_WIDTH);
    expect(line).toMatch(/· \+\d+$/);
    // The session's own numbers are never the segments that get dropped.
    expect(line).toContain("5h 55%");
    expect(line).toContain("wk 12%");
  });

  it("says something honest when the payload carried no rate limits at all", () => {
    const line = renderStatusline(undefined, context([]), { style: "compact", meters: [], color: false }, new Date());
    expect(line).toContain("no rate limit data");
  });
});

describe("parseRenderOptions", () => {
  it("is undefined without --render, so the plain bar keeps its behaviour", () => {
    expect(parseRenderOptions([], false, {})).toBeUndefined();
    expect(parseRenderOptions(["--chain", "foo"], false, {})).toBeUndefined();
  });

  it("defaults to compact, no meters and no colour, and reads --style, --meters and --color", () => {
    expect(parseRenderOptions(["--render"], false, {})).toEqual({ style: "compact", meters: [], color: false });
    expect(parseRenderOptions(["--render", "--style", "full", "--meters", "codex, claude-main:fable"], false, {}))
      .toEqual({ style: "full", meters: ["codex", "claude-main:fable"], color: false });
    expect(parseRenderOptions(["--render", "--color"], false, {})!.color).toBe(true);
  });

  it("falls back to compact for an unknown style rather than refusing to print", () => {
    expect(parseRenderOptions(["--render", "--style", "nonsense"], false, {})!.style).toBe("compact");
  });

  it("colours for a TTY unless NO_COLOR is set, and --color still wins", () => {
    expect(parseRenderOptions(["--render"], true, {})!.color).toBe(true);
    expect(parseRenderOptions(["--render"], true, { NO_COLOR: "1" })!.color).toBe(false);
    expect(parseRenderOptions(["--render", "--color"], true, { NO_COLOR: "1" })!.color).toBe(true);
  });
});
