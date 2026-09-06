import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { handleMcp } from "../src/mcp.js";
import { clipboardCommand, observationsFromUsagePaste, parseResetAt, parseUsagePanel, resolveClaudePrincipal, scopeMeter } from "../src/adapters/claude-usage-paste.js";
import { HeadroomStore } from "../src/store.js";
import type { Account } from "../src/types.js";

/** Every panel under test/fixtures/usage-paste is synthetic: hand written for
 * these tests against the shapes the parser is documented to tolerate, never
 * a capture of a real account. */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "usage-paste");
const fixture = (name: string): Promise<string> => readFile(join(fixtures, `${name}.txt`), "utf8");

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function claudeHome(prefix: string, principals: string[] = ["claude-main"]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix)); temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, "accounts.toml"), principals.flatMap((name) => [
    "[[accounts]]", `name = ${JSON.stringify(name)}`, 'vendor = "claude"', `location = ${JSON.stringify(join(root, `.${name}`))}`, 'adapter = "native-ts"', "",
  ]).join("\n"), { mode: 0o600 });
  return home;
}

function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = []; const stderr: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => { stdout.push(String(line)); });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => { stderr.push(String(line)); });
  return { stdout, stderr, restore: () => { logSpy.mockRestore(); errorSpy.mockRestore(); } };
}

/** main(["usage", "--paste", ...]) resolves the principal (reading
 * accounts.toml) before it starts reading stdin, so the payload is emitted
 * only once the command has actually attached its listeners. */
async function runUsage(argv: string[], stdin: string): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const { stdout, stderr, restore } = captureOutput();
  const before = process.stdin.listenerCount("end");
  try {
    const promise = main(["usage", ...argv]);
    const deadline = Date.now() + 4000;
    while (process.stdin.listenerCount("end") === before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    process.stdin.emit("data", stdin);
    process.stdin.emit("end");
    return { code: await promise, stdout, stderr };
  } finally { restore(); }
}

describe("parseUsagePanel", () => {
  it("reads a session and an all-models week from a bar-and-percent panel", async () => {
    const now = new Date("2026-09-06T10:00:00Z");
    const { windows, unparsed } = parseUsagePanel(await fixture("plain"), now);
    expect(unparsed).toEqual([]);
    expect(windows.map((item) => [item.meter, item.window_minutes, item.used_percent])).toEqual([["all", 300, 49], ["all", 10_080, 17]]);
    // "Resets in 2h 14m" resolves against now; the weekly reset is a date.
    expect(windows[0].resets_at).toBe(new Date(now.getTime() + (2 * 60 + 14) * 60_000).toISOString());
    expect(new Date(windows[1].resets_at!).getFullYear()).toBe(2026);
  });

  it("maps a scoped week line to the same meter slug the probe writes", async () => {
    const { windows } = parseUsagePanel(await fixture("scoped"), new Date("2026-09-06T10:00:00Z"));
    expect(windows.map((item) => item.meter)).toEqual(["all", "all", "fable", "sonnet"]);
    expect(windows.find((item) => item.meter === "fable")?.used_percent).toBe(95);
  });

  it("strips box drawing and progress bars, and ignores footer lines that carry no figure", async () => {
    const { windows, unparsed } = parseUsagePanel(await fixture("boxed"), new Date("2026-09-06T10:00:00Z"));
    expect(unparsed).toEqual([]);
    expect(windows.map((item) => [item.meter, item.used_percent])).toEqual([["all", 7], ["all", 63], ["opus", 5]]);
    // "Current week (Opus): 5%" had no reset at all: a rolling window, not a fixed one.
    expect(windows[2].resets_at).toBeNull();
  });

  it("reports a label with no percent, and a stray figure above the panel, instead of dropping them", async () => {
    const { windows, unparsed } = parseUsagePanel(await fixture("messy"), new Date("2026-09-06T10:00:00Z"));
    expect(windows.map((item) => [item.meter, item.used_percent])).toEqual([["all", 22], ["fable", 88]]);
    expect(unparsed).toEqual(["Current week (all models)"]);
  });

  it("returns nothing at all for text that is not a usage panel", () => {
    expect(parseUsagePanel("hello\nthere", new Date()).windows).toEqual([]);
  });
});

describe("parseResetAt", () => {
  const now = new Date("2026-09-06T12:00:00");

  it("resolves a relative countdown", () => {
    expect(parseResetAt(" in 2h 14m", now)).toBe(new Date(now.getTime() + 134 * 60_000).toISOString());
    expect(parseResetAt(" in 45 minutes", now)).toBe(new Date(now.getTime() + 45 * 60_000).toISOString());
    expect(parseResetAt(" in 1d 3h", now)).toBe(new Date(now.getTime() + 27 * 3_600_000).toISOString());
  });

  it("resolves a clock time to the next occurrence, dropping a timezone annotation", () => {
    expect(new Date(parseResetAt(" at 14:00", now)!).getHours()).toBe(14);
    expect(new Date(parseResetAt(" 3pm (Europe/Amsterdam)", now)!).getHours()).toBe(15);
    // 9am has already passed at 12:00, so it means tomorrow.
    expect(new Date(parseResetAt(" 9am", now)!).getDate()).toBe(7);
  });

  it("resolves a date, a weekday, and rolls the year over when the month has passed", () => {
    const dated = new Date(parseResetAt(" Sep 13, 2:00pm", now)!);
    expect([dated.getMonth(), dated.getDate(), dated.getHours()]).toEqual([8, 13, 14]);
    expect(new Date(parseResetAt(" 13 Sep 14:00", now)!).getDate()).toBe(13);
    expect(new Date(parseResetAt(" Sat 09:30", now)!).getDay()).toBe(6);
    expect(new Date(parseResetAt(" Jan 4, 09:00", now)!).getFullYear()).toBe(2027);
  });

  it("returns null for a reset it cannot read", () => {
    expect(parseResetAt(" soon", now)).toBeNull();
    expect(parseResetAt("", now)).toBeNull();
  });
});

describe("scopeMeter", () => {
  it("keeps the account-wide meter for an unscoped or all-models label", () => {
    expect(scopeMeter(undefined)).toBe("all");
    expect(scopeMeter("all models")).toBe("all");
  });

  it("uses the named families and otherwise the display name's slug, without a trailing 'only'", () => {
    expect(scopeMeter("Fable")).toBe("fable");
    expect(scopeMeter("Routines")).toBe("routines");
    expect(scopeMeter("Sonnet only")).toBe("sonnet");
    expect(scopeMeter("Opus 4.6")).toBe("opus-4-6");
  });
});

describe("resolveClaudePrincipal", () => {
  const claude = (name: string): Account => ({ name, vendor: "claude", location: `/nonexistent/${name}`, adapter: "native-ts" });

  it("uses the only configured Claude principal", () => {
    expect(resolveClaudePrincipal([claude("claude-main"), { name: "codex-main", vendor: "codex", location: "/nonexistent/.codex", adapter: "native-ts" }])).toBe("claude-main");
  });

  it("requires --principal when more than one is configured, and rejects one that is not Claude", () => {
    expect(() => resolveClaudePrincipal([claude("a"), claude("b")])).toThrow(/several Claude principals/);
    expect(() => resolveClaudePrincipal([claude("a")], "codex-main")).toThrow(/not a configured Claude principal/);
    expect(() => resolveClaudePrincipal([])).toThrow(/no Claude principal/);
  });
});

describe("observationsFromUsagePaste", () => {
  it("marks the readings official at 0.9 confidence, sourced 'paste', on the principal's own meters", async () => {
    const now = new Date("2026-09-06T10:00:00Z");
    const { windows } = parseUsagePanel(await fixture("scoped"), now);
    const observations = observationsFromUsagePaste(windows, "claude-main", now);
    expect(observations.map((item) => item.meter_id)).toEqual(["claude-main:all", "claude-main:all", "claude-main:fable", "claude-main:sonnet"]);
    for (const item of observations) {
      expect(item.source).toBe("paste");
      expect(item.truth).toBe("official");
      expect(item.confidence).toBe(0.9);
      expect(item.freshness).toBe("fresh");
      expect(item.observed_at).toBe(now.toISOString());
    }
    expect(observations[0].window).toEqual({ kind: "fixed", minutes: 300, enforcement: "hard" });
    expect(observations[2].quantity).toEqual({ used: 95, limit: 100, remaining: 5, unit: "percent" });
  });
});

describe("clipboardCommand", () => {
  it("uses pbpaste on macOS and Get-Clipboard on Windows", () => {
    expect(clipboardCommand("darwin", () => false).command).toBe("pbpaste");
    expect(clipboardCommand("win32", () => false)).toEqual({ command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"] });
  });

  it("prefers xclip on Linux, falls back to wl-paste, and names both when neither is installed", () => {
    expect(clipboardCommand("linux", (name) => name === "xclip")).toEqual({ command: "xclip", args: ["-selection", "clipboard", "-o"] });
    expect(clipboardCommand("linux", (name) => name === "wl-paste").command).toBe("wl-paste");
    expect(() => clipboardCommand("linux", () => false)).toThrow(/xclip or wl-paste/);
  });
});

describe("headroom usage --paste", () => {
  it("stores the pasted windows, prints one line each, and exits 0", async () => {
    const home = await claudeHome("headroom-usage-paste-");
    const panel = await fixture("scoped");
    await withHeadroomHome(home, async () => {
      const { code, stdout } = await runUsage(["--paste"], panel);
      expect(code).toBe(0);
      expect(stdout).toHaveLength(4);
      expect(stdout[0]).toMatch(/^ingested claude-main:all 5h 12% used, resets /);
      expect(stdout.some((line) => /^ingested claude-main:fable wk 95% used, resets /.test(line))).toBe(true);

      const store = await HeadroomStore.open(home);
      try {
        const stored = store.latestPerWindow("claude-main:fable");
        expect(stored).toHaveLength(1);
        expect(stored[0].quantity?.used).toBe(95);
        expect(stored[0].source).toBe("paste");
        expect(stored[0].truth).toBe("official");
      } finally { store.close(); }
    });
  });

  it("warns about a line it could not place, and still ingests the rest", async () => {
    const home = await claudeHome("headroom-usage-paste-warn-");
    const panel = await fixture("messy");
    await withHeadroomHome(home, async () => {
      const { code, stdout, stderr } = await runUsage(["--paste"], panel);
      expect(code).toBe(0);
      expect(stdout).toHaveLength(2);
      expect(stderr).toEqual(['warning: could not read "Current week (all models)"']);
    });
  });

  it("exits 1 when nothing in the text is a usage window", async () => {
    const home = await claudeHome("headroom-usage-paste-empty-");
    await withHeadroomHome(home, async () => {
      const { code, stdout, stderr } = await runUsage(["--paste"], "nothing to see here\n");
      expect(code).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toContain("no usage window in the pasted text");
    });
  });

  it("--json prints the stored observations with their countdowns", async () => {
    const home = await claudeHome("headroom-usage-paste-json-");
    const panel = await fixture("plain");
    await withHeadroomHome(home, async () => {
      const { code, stdout } = await runUsage(["--paste", "--json"], panel);
      expect(code).toBe(0);
      const rows = JSON.parse(stdout[0]);
      expect(rows).toHaveLength(2);
      expect(rows[0].meter_id).toBe("claude-main:all");
      expect(rows[0].id).toBeGreaterThan(0);
      expect(rows[0].resets_in).toMatch(/^2h 1[34]m$/);
    });
  });

  it("requires --principal when two Claude principals are configured", async () => {
    const home = await claudeHome("headroom-usage-paste-two-", ["claude-main", "claude-second"]);
    const panel = await fixture("plain");
    await withHeadroomHome(home, async () => {
      await expect(main(["usage", "--paste"])).rejects.toThrow(/several Claude principals/);
      const { code, stdout } = await runUsage(["--paste", "--principal", "claude-second"], panel);
      expect(code).toBe(0);
      expect(stdout[0]).toContain("claude-second:all");
    });
  });

  it("rejects an unknown flag and a missing or doubled input source", async () => {
    const home = await claudeHome("headroom-usage-paste-flags-");
    await withHeadroomHome(home, async () => {
      await expect(main(["usage", "--nope"])).rejects.toThrow(/--paste \| --clipboard/);
      await expect(main(["usage"])).rejects.toThrow(/--paste \| --clipboard/);
      await expect(main(["usage", "--paste", "--clipboard"])).rejects.toThrow(/--paste \| --clipboard/);
    });
  });
});

describe("quota_usage_paste", () => {
  const call = (params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> =>
    handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_usage_paste", arguments: params } }));

  it("is advertised in tools/list, making fourteen tools", async () => {
    const listed = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const names = ((listed?.result as { tools: Array<{ name: string }> }).tools).map((item) => item.name);
    expect(names).toHaveLength(14);
    expect(names).toContain("quota_usage_paste");
  });

  it("stores the same observations the CLI does, and reports what it could not read", async () => {
    const home = await claudeHome("headroom-usage-paste-mcp-");
    const panel = await fixture("messy");
    await withHeadroomHome(home, async () => {
      const reply = await call({ text: panel });
      const result = (reply?.result as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(result.principal).toBe("claude-main");
      expect(result.unparsed).toEqual(["Current week (all models)"]);
      const observations = result.observations as Array<{ meter_id: string; source: string }>;
      expect(observations.map((item) => item.meter_id)).toEqual(["claude-main:all", "claude-main:fable"]);
      expect(observations[0].source).toBe("paste");

      const store = await HeadroomStore.open(home);
      try { expect(store.latestPerWindow("claude-main:fable")[0].quantity?.used).toBe(88); }
      finally { store.close(); }
    });
  });

  it("rejects an empty text, an unknown argument, and a panel with no window", async () => {
    const home = await claudeHome("headroom-usage-paste-mcp-bad-");
    await withHeadroomHome(home, async () => {
      expect(((await call({ text: "  " }))?.error as { message: string }).message).toMatch(/text is required/);
      expect(((await call({ text: "x", meter: "y" }))?.error as { message: string }).message).toMatch(/unknown argument: meter/);
      expect(((await call({ text: "nothing here" }))?.error as { message: string }).message).toMatch(/no usage window/);
    });
  });
});
