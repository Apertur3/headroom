import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { fillFor, gateFor, planFor } from "../src/orchestrator-reads.js";
import { defaultPolicy, parsePolicy, reserveFor } from "../src/policy.js";
import { clearReserveEntry, parseUntil, setFreezeReservePct, upsertReserveEntry } from "../src/policy-configure.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-reserves-")); temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  return { logs, restore: () => spy.mockRestore() };
}

function fiveHour(meterId: string, used: number, resetsAtMs = Date.now() + 4 * 3_600_000): Observation {
  const fetchedAt = new Date().toISOString();
  const principal = meterId.split(":")[0];
  return {
    principal_id: principal, meter_id: meterId, window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: new Date(resetsAtMs).toISOString(),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

function weekly(meterId: string, used: number, resetsAtMs = Date.now() + 3 * 86_400_000): Observation {
  const fetchedAt = new Date().toISOString();
  const principal = meterId.split(":")[0];
  return {
    principal_id: principal, meter_id: meterId, window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: new Date(resetsAtMs).toISOString(),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

describe("parsePolicy: dated/reasoned reserve entries", () => {
  it("keeps the plain numeric [reserve] form and freeze_reserve_pct working unchanged, alongside a dated entry", () => {
    const policy = parsePolicy([
      "freeze_reserve_pct = 15",
      "[reserve]",
      '"claude-main:all" = 7',
      '"*" = 2',
      "",
      '[reserve."codex-main:main"]',
      "percent = 30",
      'reason = "stop new Codex builds at 70% used"',
      'set_at = "2026-09-23T09:00:00Z"',
    ].join("\n"));
    expect(policy.reserve).toEqual({ "claude-main:all": 7, "*": 2, "codex-main:main": 30 });
    expect(reserveFor(policy.reserve, "claude-main:all")).toBe(7);
    expect(reserveFor(policy.reserve, "some-other:meter")).toBe(2); // the "*" default, untouched
    expect(policy.reserve_meta["claude-main:all"]).toEqual({ percent: 7 });
    expect(policy.reserve_meta["codex-main:main"]).toMatchObject({ percent: 30, reason: "stop new Codex builds at 70% used", set_at: "2026-09-23T09:00:00.000Z" });
    expect(policy.freeze_reserve_pct).toBe(15);
  });

  it("expires a dated reserve at the exact `until` instant, and not a moment before", () => {
    const text = ['[reserve."codex-main:main"]', "percent = 30", 'until = "2026-09-30T00:00:00Z"'].join("\n");
    const before = parsePolicy(text, new Date("2026-09-29T23:59:59.999Z"));
    expect(before.reserve["codex-main:main"]).toBe(30);
    expect(before.reserve_meta["codex-main:main"].percent).toBe(30); // original percent kept even once resolved
    const atInstant = parsePolicy(text, new Date("2026-09-30T00:00:00.000Z"));
    expect(atInstant.reserve["codex-main:main"]).toBe(0);
    // The metadata itself is retained (unlike `reserve`), so a caller can
    // still report that it existed and lapsed.
    expect(atInstant.reserve_meta["codex-main:main"]).toMatchObject({ percent: 30, until: "2026-09-30T00:00:00.000Z" });
    const after = parsePolicy(text, new Date("2026-10-01T00:00:00Z"));
    expect(after.reserve["codex-main:main"]).toBe(0);
  });

  it("fails closed on an unparseable or out-of-range dated entry, never silently dropping it", () => {
    expect(() => parsePolicy('[reserve."codex-main:main"]\nreason = "x"\n')).toThrow("Invalid Headroom policy"); // no percent
    expect(() => parsePolicy('[reserve."codex-main:main"]\npercent = 91\n')).toThrow("Invalid Headroom policy");
    expect(() => parsePolicy('[reserve."codex-main:main"]\npercent = 30\nunless = "nope"\n')).toThrow("Invalid Headroom policy");
    expect(() => parsePolicy('[reserve."codex-main:main"]\npercent = 30\nuntil = "not-a-date"\n')).toThrow("Invalid Headroom policy");
    expect(() => parsePolicy('[reserve."codex-main:main"]\npercent = 30\nbogus = 1\n')).toThrow("Invalid Headroom policy");
  });

  it("carries freeze_reserve_pct's own [freeze_reserve] metadata without changing its numeric value", () => {
    const policy = parsePolicy(['freeze_reserve_pct = 20', "[freeze_reserve]", 'reason = "burn the week to 100%"', 'set_at = "2026-09-27T08:00:00Z"'].join("\n"));
    expect(policy.freeze_reserve_pct).toBe(20);
    expect(policy.reserve_meta.freeze_reserve_pct).toMatchObject({ percent: 20, reason: "burn the week to 100%", set_at: "2026-09-27T08:00:00.000Z" });
  });

  it("has no reserve_meta at all when no dated form or [freeze_reserve] table is present", () => {
    expect(defaultPolicy.reserve_meta).toEqual({});
    expect(parsePolicy("freeze_reserve_pct = 10\n").reserve_meta).toEqual({});
  });
});

describe("reserve refusal attribution", () => {
  it("names the reserve's own key, reason and set_at date in a gate refusal", async () => {
    const home = await tempHome();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(fiveHour("codex-main:main", 85));
      const reserveMeta = { "codex-main:main": { percent: 30, reason: "stop new Codex builds at 70% used", set_at: "2026-09-23T09:00:00.000Z" } };
      const result = gateFor(store, [{ window: "5h", points: 6 }], "codex-main:main", 0, false, new Date(), { owner: "orchestrator", pacing: "none", reserves: { "codex-main:main": 30 }, reserveMeta });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("would use the 30% reserve on codex-main:main");
      expect(result.reason).toContain("stop new Codex builds at 70% used");
      expect(result.reason).toContain("set 2026-09-23");
    } finally { store.close(); }
  });

  it("falls back to the policy file's own mtime when a reserve names no reason or set_at", async () => {
    const home = await tempHome();
    await writeFile(join(home, "policy.toml"), '[reserve]\n"codex-main:main" = 30\n', { mode: 0o600 });
    await writeFile(join(home, "routing.toml"), '[consumes]\ncodex-main-fable = ["codex-main:main"]\n', { mode: 0o600 });
    await writeFile(join(home, "accounts.toml"), '[[accounts]]\nname = "codex-main"\nvendor = "codex"\nlocation = "/tmp/codex-main"\nadapter = "native-ts"\n', { mode: 0o600 });
    const store = await HeadroomStore.open(home);
    store.insert(fiveHour("codex-main:main", 85));
    store.close();
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["gate", "--need", "5h:6", "--meter", "codex-main:main", "--owner", "orchestrator"])).toBe(2);
      });
    } finally { restore(); }
    const line = logs.join("\n");
    expect(line).toContain("would use the 30% reserve on codex-main:main");
    // No reason/set_at on the plain bare form -- falls back to the policy
    // file's own mtime date instead of a bare, unexplained number.
    expect(line).toMatch(/policy\.toml updated \d{4}-\d{2}-\d{2}/);
  });

  it("attributes a freeze_reserve_pct-driven refusal to that key, not the meter", async () => {
    const home = await tempHome();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(fiveHour("codex-main:main", 85));
      const result = gateFor(store, [{ window: "5h", points: 6 }], "codex-main:main", 10, false, new Date(), {
        owner: "orchestrator", pacing: "none", reserveMeta: { freeze_reserve_pct: { percent: 10, reason: "burn the week to 100%", set_at: "2026-09-27T08:00:00.000Z" } },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("before the 10% reserve");
      expect(result.reason).toContain("freeze_reserve_pct");
      expect(result.reason).toContain("burn the week to 100%");
    } finally { store.close(); }
  });
});

describe("unless: banked_reset_available suspension", () => {
  const reserveMeta = { "codex-main:main": { percent: 30, unless: "banked_reset_available" as const } };

  it("keeps enforcing the reserve with no banked reset on file", async () => {
    const home = await tempHome();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(fiveHour("codex-main:main", 85));
      const result = gateFor(store, [{ window: "5h", points: 6 }], "codex-main:main", 0, false, new Date(), { owner: "orchestrator", pacing: "none", reserves: { "codex-main:main": 30 }, reserveMeta });
      expect(result.allowed).toBe(false);
    } finally { store.close(); }
  });

  it("suspends the reserve while a current (manual) banked reset is available", async () => {
    const home = await tempHome();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(fiveHour("codex-main:main", 85));
      store.recordManualCredits("codex-main", 1, new Date(Date.now() + 7 * 86_400_000).toISOString());
      const result = gateFor(store, [{ window: "5h", points: 6 }], "codex-main:main", 0, false, new Date(), { owner: "orchestrator", pacing: "none", reserves: { "codex-main:main": 30 }, reserveMeta });
      expect(result.allowed).toBe(true);
    } finally { store.close(); }
  });

  it("does not suspend the reserve once the banked reset has lapsed", async () => {
    const home = await tempHome();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(fiveHour("codex-main:main", 85));
      store.recordManualCredits("codex-main", 1, new Date(Date.now() - 60_000).toISOString()); // already expired
      const result = gateFor(store, [{ window: "5h", points: 6 }], "codex-main:main", 0, false, new Date(), { owner: "orchestrator", pacing: "none", reserves: { "codex-main:main": 30 }, reserveMeta });
      expect(result.allowed).toBe(false);
    } finally { store.close(); }
  });

  it("also suspends the reserve for fill and plan, and never for an unrelated meter", async () => {
    const home = await tempHome();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(fiveHour("codex-main:main", 60));
      store.insert(weekly("codex-main:main", 60));
      store.recordManualCredits("codex-main", 1, new Date(Date.now() + 7 * 86_400_000).toISOString());
      const suspended = await fillFor(store, "codex-main:main", 10, 10, new Date(), { owner: "orchestrator", pacing: "none", reserves: { "codex-main:main": 30 }, reserveMeta });
      const notSuspended = await fillFor(store, "codex-main:main", 10, 10, new Date(), { owner: "orchestrator", pacing: "none", reserves: { "codex-main:main": 30 } });
      expect("lanes" in suspended && suspended.lanes?.lanes).toBeGreaterThan("lanes" in notSuspended && notSuspended.lanes ? notSuspended.lanes.lanes : 0);

      store.insert(fiveHour("claude-main:fable", 60));
      store.insert(weekly("claude-main:fable", 60));
      const otherMeter = await fillFor(store, "claude-main:fable", 10, 10, new Date(), { owner: "orchestrator", pacing: "none", reserves: { "claude-main:fable": 30 }, reserveMeta });
      expect("lanes" in otherMeter && otherMeter.lanes?.lanes).toBe("lanes" in notSuspended && notSuspended.lanes ? notSuspended.lanes.lanes : -1);
    } finally { store.close(); }
  });
});

describe("plan/fill reserve ceiling line", () => {
  it("lists every reserve capping the meter, tightest first, and notes points a banked reset would restore", async () => {
    const home = await tempHome();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(weekly("codex-main:main", 20));
      store.insert(fiveHour("codex-main:main", 20));
      store.recordManualCredits("codex-main", 1, new Date(Date.now() + 7 * 86_400_000).toISOString());
      const reserveMeta = { "codex-main:main": { percent: 30, reason: "stop new Codex builds at 70% used", set_at: "2026-09-23T09:00:00.000Z" } };
      const result = planFor(store, "codex-main:main", 10, new Date(), defaultPolicy.staleness_minutes, { "codex-main:main": 30 }, undefined, undefined, reserveMeta, null);
      if ("error" in result) throw new Error(`unexpected plan error: ${result.error}`);
      expect(result.reserve_ceiling).toContain("usable to 70%: [reserve] codex-main:main = 30 (stop new Codex builds at 70% used, set 2026-09-23)");
      expect(result.reserve_ceiling).toContain("then to 90%: freeze_reserve_pct = 10");
      expect(result.reserve_ceiling).toContain("the reserves block 30 points that a banked reset would restore");
    } finally { store.close(); }
  });

  it("omits the banked-reset note when no banked reset is on file", async () => {
    const home = await tempHome();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(weekly("codex-main:main", 20));
      store.insert(fiveHour("codex-main:main", 20));
      const result = planFor(store, "codex-main:main", 10, new Date(), defaultPolicy.staleness_minutes, { "codex-main:main": 30 }, undefined, undefined, {}, null);
      if ("error" in result) throw new Error(`unexpected plan error: ${result.error}`);
      expect(result.reserve_ceiling).not.toContain("banked reset would restore");
      expect(result.reserve_ceiling).toContain("usable to 70%");
    } finally { store.close(); }
  });

  it("is empty when neither a per-meter reserve nor freeze_reserve_pct applies", async () => {
    const home = await tempHome();
    const store = await HeadroomStore.open(home);
    try {
      store.insert(weekly("codex-main:main", 20));
      store.insert(fiveHour("codex-main:main", 20));
      const result = planFor(store, "codex-main:main", 0, new Date(), defaultPolicy.staleness_minutes, {}, undefined, undefined, {}, null);
      if ("error" in result) throw new Error(`unexpected plan error: ${result.error}`);
      expect(result.reserve_ceiling).toBe("");
    } finally { store.close(); }
  });
});

describe("policy-configure: safe TOML edits", () => {
  it("upserts a dated reserve entry, replacing any bare form for the same meter, keeping everything else", () => {
    const original = '# keep me\nfreeze_reserve_pct = 10\n\n[reserve]\n"codex-main:main" = 20  # stale\n"claude-main:all" = 5\n\n[notify]\nchannels = []\n';
    const updated = upsertReserveEntry(original, "codex-main:main", { percent: 30, reason: "stop new Codex builds at 70% used", set_at: "2026-09-23T09:00:00.000Z" });
    expect(updated).toContain("# keep me");
    expect(updated).toContain('"claude-main:all" = 5');
    expect(updated).toContain("[notify]\nchannels = []");
    expect(updated).not.toMatch(/"codex-main:main" = 20/);
    expect(updated).toContain('[reserve."codex-main:main"]');
    expect(updated).toContain("percent = 30");
    const parsed = parsePolicy(updated);
    expect(parsed.reserve["codex-main:main"]).toBe(30);
    expect(parsed.reserve["claude-main:all"]).toBe(5);
    // A second upsert replaces the section in place rather than duplicating it.
    const again = upsertReserveEntry(updated, "codex-main:main", { percent: 40, set_at: "2026-09-24T00:00:00.000Z" });
    expect((again.match(/\[reserve\."codex-main:main"\]/g) ?? []).length).toBe(1);
    expect(parsePolicy(again).reserve["codex-main:main"]).toBe(40);
  });

  it("clears both the bare and dated forms, leaving unrelated entries and comments intact", () => {
    const original = '[reserve]\n"claude-main:all" = 5\n\n[reserve."codex-main:main"]\npercent = 30\nreason = "x"\n';
    const cleared = clearReserveEntry(original, "codex-main:main");
    expect(cleared).toContain('"claude-main:all" = 5');
    expect(cleared).not.toContain("codex-main:main");
    expect(parsePolicy(cleared).reserve).toEqual({ "claude-main:all": 5 });
  });

  it("sets freeze_reserve_pct in place and only touches [freeze_reserve] when metadata is given", () => {
    const original = "# top\nfreeze_reserve_pct = 10\n\n[reserve]\n\"*\" = 2\n";
    const bare = setFreezeReservePct(original, 20);
    expect(bare).toContain("freeze_reserve_pct = 20");
    expect(bare).not.toContain("[freeze_reserve]");
    expect(bare).toContain('"*" = 2');
    const withMeta = setFreezeReservePct(original, 20, { reason: "burn the week to 100%", set_at: "2026-09-27T08:00:00.000Z" });
    expect(withMeta).toContain("[freeze_reserve]");
    expect(withMeta).toContain('reason = "burn the week to 100%"');
    const parsed = parsePolicy(withMeta);
    expect(parsed.freeze_reserve_pct).toBe(20);
    expect(parsed.reserve_meta.freeze_reserve_pct).toMatchObject({ reason: "burn the week to 100%" });
  });

  it("parses a relative --until duration and a plain ISO instant", () => {
    const now = new Date("2026-09-23T09:00:00.000Z");
    expect(parseUntil("+7d", now)).toBe("2026-09-30T09:00:00.000Z");
    expect(parseUntil("+24h", now)).toBe("2026-09-24T09:00:00.000Z");
    expect(parseUntil("2026-10-01T00:00:00Z", now)).toBe("2026-10-01T00:00:00.000Z");
    expect(() => parseUntil("not-a-date", now)).toThrow(/--until/);
  });
});

describe("headroom policy CLI", () => {
  it("policy set reserve writes atomically with a timestamped backup, 0600 mode, and prints the before/after line", async () => {
    const home = await tempHome();
    const original = "# a comment\nfreeze_reserve_pct = 12\n\n[reserve]\n\"claude-main:all\" = 5\n";
    await writeFile(join(home, "policy.toml"), original, { mode: 0o600 });
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["policy", "set", "reserve", "codex-main:main", "30", "--reason", "stop new Codex builds at 70% used", "--until", "+7d"])).toBe(0);
      });
    } finally { restore(); }
    expect(logs.join("\n")).toContain("codex-main:main: unset -> 30%, stop new Codex builds at 70% used");

    const written = await readFile(join(home, "policy.toml"), "utf8");
    expect(written).toContain("# a comment");
    expect(written).toContain('"claude-main:all" = 5');
    const parsed = parsePolicy(written);
    expect(parsed.reserve["codex-main:main"]).toBe(30);
    expect(parsed.reserve_meta["codex-main:main"].reason).toBe("stop new Codex builds at 70% used");
    expect(parsed.reserve_meta["codex-main:main"].until).toBeTruthy();

    const files = await readdir(home);
    const backups = files.filter((name) => name.startsWith("policy.toml.bak-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(home, backups[0]), "utf8")).toBe(original);
    const { stat } = await import("node:fs/promises");
    // Windows has no POSIX permission bits (it reports 0666 whatever was asked).
    if (process.platform !== "win32") expect((await stat(join(home, "policy.toml"))).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect((await stat(join(home, backups[0]))).mode & 0o777).toBe(0o600);
  });

  it("rejects a missing --reason, an out-of-range percent, and a bad --unless value without writing anything", async () => {
    const home = await tempHome();
    await withHeadroomHome(home, async () => {
      await expect(main(["policy", "set", "reserve", "codex-main:main", "30"])).rejects.toThrow(/--reason/);
      await expect(main(["policy", "set", "reserve", "codex-main:main", "95", "--reason", "x"])).rejects.toThrow(/0 through 90/);
      await expect(main(["policy", "set", "reserve", "codex-main:main", "30", "--reason", "x", "--unless", "nope"])).rejects.toThrow(/--unless/);
    });
    await expect(readFile(join(home, "policy.toml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("policy clear reserve removes the entry, keeps comments/other keys, backs up first, and prints the before/after line", async () => {
    const home = await tempHome();
    const original = '# keep\n[reserve."codex-main:main"]\npercent = 30\nreason = "stop new Codex builds at 70% used"\n\n[reserve]\n"claude-main:all" = 5\n';
    await writeFile(join(home, "policy.toml"), original, { mode: 0o600 });
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["policy", "clear", "reserve", "codex-main:main"])).toBe(0);
      });
    } finally { restore(); }
    expect(logs.join("\n")).toContain("codex-main:main: 30%, stop new Codex builds at 70% used -> cleared");
    const written = await readFile(join(home, "policy.toml"), "utf8");
    expect(written).toContain("# keep");
    expect(written).toContain('"claude-main:all" = 5');
    expect(written).not.toContain("codex-main:main");
    const files = await readdir(home);
    expect(files.some((name) => name.startsWith("policy.toml.bak-"))).toBe(true);
  });

  it("policy set freeze_reserve_pct updates the value and its metadata, and policy show reports it", async () => {
    const home = await tempHome();
    await writeFile(join(home, "policy.toml"), "freeze_reserve_pct = 10\n", { mode: 0o600 });
    await withHeadroomHome(home, async () => {
      expect(await main(["policy", "set", "freeze_reserve_pct", "20", "--reason", "burn the week to 100%"])).toBe(0);
    });
    const written = await readFile(join(home, "policy.toml"), "utf8");
    expect(written).toContain("freeze_reserve_pct = 20");
    expect(written).toContain("[freeze_reserve]");

    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["policy", "show", "--json"])).toBe(0);
      });
    } finally { restore(); }
    const shown = JSON.parse(logs[0]) as { freeze_reserve_pct: number; freeze_reserve_meta: { reason: string } | null; reserves: unknown[] };
    expect(shown.freeze_reserve_pct).toBe(20);
    expect(shown.freeze_reserve_meta?.reason).toBe("burn the week to 100%");
  });

  it("policy show reports an expired reserve as not applying, without deleting its metadata", async () => {
    const home = await tempHome();
    await writeFile(join(home, "policy.toml"), '[reserve."codex-main:main"]\npercent = 30\nuntil = "2000-01-01T00:00:00Z"\n', { mode: 0o600 });
    const { logs, restore } = captureLog();
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["policy", "show"])).toBe(0);
      });
    } finally { restore(); }
    const line = logs.find((entry) => entry.startsWith("codex-main:main"));
    expect(line).toContain("not applying");
    expect(line).toContain("expired 2000-01-01");
  });
});

describe("headroom policy CLI: concurrent-safe edits", () => {
  it("serializes two concurrent `policy set reserve` writers so neither erases the other's edit", async () => {
    const home = await tempHome();
    await writeFile(join(home, "policy.toml"), "freeze_reserve_pct = 10\n", { mode: 0o600 });
    await withHeadroomHome(home, async () => {
      // Both invocations start from the same on-disk policy.toml. Without
      // serialization, both read it before either writes, and the second
      // writer's rename silently erases the first writer's edit -- exactly
      // the race described in review finding 10. Promise.all runs both
      // main() calls genuinely concurrently within this one process. This is
      // an integration smoke test that withPolicyLock is actually wired into
      // the CLI commands -- Promise.all alone does not force a genuine
      // interleaving, so it is not, on its own, proof that the lock actually
      // serializes anything (a passing run here could still happen to get
      // lucky). test/exclusive-lock.test.ts tests withExclusiveLock itself
      // with explicit deferred barriers for that.
      const [codeA, codeB] = await Promise.all([
        main(["policy", "set", "reserve", "codex-main:main", "30", "--reason", "stop new Codex builds at 70% used"]),
        main(["policy", "set", "reserve", "claude-main:all", "20", "--reason", "stop new Claude builds at 80% used"]),
      ]);
      expect(codeA).toBe(0);
      expect(codeB).toBe(0);
    });
    const written = await readFile(join(home, "policy.toml"), "utf8");
    const parsed = parsePolicy(written);
    expect(parsed.reserve["codex-main:main"]).toBe(30);
    expect(parsed.reserve["claude-main:all"]).toBe(20);
    // No lock file left behind once both writers finish.
    await expect(readFile(join(home, "policy.toml.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives two backups that land in the same millisecond their own distinct files", async () => {
    const home = await tempHome();
    const original = "freeze_reserve_pct = 10\n";
    await writeFile(join(home, "policy.toml"), original, { mode: 0o600 });
    const fixedStamp = "2026-09-28T00:00:00.000Z";
    const isoSpy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue(fixedStamp);
    try {
      await withHeadroomHome(home, async () => {
        expect(await main(["policy", "set", "reserve", "codex-main:main", "30", "--reason", "a"])).toBe(0);
        expect(await main(["policy", "set", "reserve", "claude-main:all", "20", "--reason", "b"])).toBe(0);
      });
    } finally { isoSpy.mockRestore(); }
    const files = await readdir(home);
    const backups = files.filter((name) => name.startsWith("policy.toml.bak-2026-09-28T00-00-00-000Z"));
    // A plain writeFile at the same stamped name would have left only one
    // backup, the second call's write silently replacing the first's.
    expect(backups).toHaveLength(2);
    const contents = await Promise.all(backups.map((name) => readFile(join(home, name), "utf8")));
    expect(contents).toContain(original); // the pre-first-edit backup survives intact
    expect(new Set(contents).size).toBe(2); // the two backups are genuinely different snapshots
  });
});

describe("reserve review fixes", () => {
  it("keeps a # inside a quoted reason instead of treating it as a comment", async () => {
    const { parsePolicy } = await import("../src/policy.js");
    const policy = parsePolicy('[reserve."codex-main:main"]\npercent = 30\nreason = "stop #123 builds" # trailing comment\n');
    expect(policy.reserve_meta["codex-main:main"]?.reason).toBe("stop #123 builds");
    expect(policy.reserve["codex-main:main"]).toBe(30);
  });

  it("lists a suspended reserve in the ceiling steps, zeroed and marked, instead of dropping it", async () => {
    const { parsePolicy, reserveCeilingSteps } = await import("../src/policy.js");
    const policy = parsePolicy('freeze_reserve_pct = 0\n[reserve."codex-main:main"]\npercent = 30\nreason = "hold"\nunless = "banked_reset_available"\n');
    const steps = reserveCeilingSteps(policy, "codex-main:main", true);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ key: "codex-main:main", percent: 0, usable_to: 100, suspended: true });
  });

  it("never gives the freeze reserve the wildcard entry's reason", async () => {
    const { parsePolicy, reserveCeilingSteps } = await import("../src/policy.js");
    const policy = parsePolicy('freeze_reserve_pct = 10\n[reserve."*"]\npercent = 5\nreason = "wildcard reason"\n');
    const freeze = reserveCeilingSteps(policy, "codex-main:main", false).find((step) => step.key === "freeze_reserve_pct");
    expect(freeze?.reason).toBeUndefined();
  });
});

