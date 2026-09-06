import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, spendLines } from "../src/cli.js";
import { attributeSpend, UNATTRIBUTED_OWNER } from "../src/cost.js";
import { handleMcp } from "../src/mcp.js";
import { HeadroomStore, SPEND_LEDGER_RETENTION_DAYS } from "../src/store.js";
import { rateLines } from "../src/orchestrator-reads.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-spend-"));
  temporary.push(root);
  return join(root, ".headroom");
}

async function open(): Promise<HeadroomStore> { return HeadroomStore.open(await home()); }

async function withHeadroomHome<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = path;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

function rolling(used: number, fetchedAt: string, resetsAt = "2026-09-06T17:00:00Z", overrides: Partial<Observation> = {}): Observation {
  return {
    principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: resetsAt,
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...overrides,
  };
}

describe("attributeSpend", () => {
  it("books a delta nobody leased to unattributed at half confidence", () => {
    expect(attributeSpend(10, [])).toEqual([{ owner: UNATTRIBUTED_OWNER, share_percent: 10, confidence: 0.5 }]);
  });

  it("gives a single active owner the whole delta at full confidence", () => {
    expect(attributeSpend(10, [{ owner: "a", expect: 5 }])).toEqual([{ owner: "a", share_percent: 10, confidence: 1 }]);
  });

  it("splits by expectation, and lowers confidence, across simultaneous owners", () => {
    expect(attributeSpend(12, [{ owner: "a", expect: 30 }, { owner: "b", expect: 10 }])).toEqual([
      { owner: "a", share_percent: 9, confidence: 0.5 },
      { owner: "b", share_percent: 3, confidence: 0.5 },
    ]);
  });

  it("splits equally when no owner declared an expectation", () => {
    expect(attributeSpend(9, [{ owner: "a", expect: null }, { owner: "b", expect: null }, { owner: "c", expect: null }]))
      .toEqual([{ owner: "a", share_percent: 3, confidence: 1 / 3 }, { owner: "b", share_percent: 3, confidence: 1 / 3 }, { owner: "c", share_percent: 3, confidence: 1 / 3 }]);
  });

  it("falls back to equal shares rather than dropping a delta when every weight is zero", () => {
    expect(attributeSpend(8, [{ owner: "a", expect: 0 }, { owner: "b", expect: 0 }])).toEqual([
      { owner: "a", share_percent: 4, confidence: 0.5 },
      { owner: "b", share_percent: 4, confidence: 0.5 },
    ]);
  });

  it("writes nothing at all for a zero or negative delta", () => {
    expect(attributeSpend(0, [{ owner: "a", expect: null }])).toEqual([]);
    expect(attributeSpend(-5, [{ owner: "a", expect: null }])).toEqual([]);
  });
});

describe("store.spendByOwner", () => {
  it("attributes a window's whole movement to the one owner holding it", async () => {
    const store = await open();
    try {
      store.insert(rolling(10, "2026-09-06T12:00:00Z"));
      store.startLease("session-a", "claude-main:all", 20, 3_600_000, null, new Date("2026-09-06T12:00:00Z"));
      store.insert(rolling(25, "2026-09-06T12:30:00Z"));
      const rows = store.spendByOwner({ since: "2026-09-06T00:00:00Z" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ meter_id: "claude-main:all", window_minutes: 300, owner: "session-a", confidence: 1, samples: 1 });
      expect(rows[0].attributed_percent).toBeCloseTo(15, 9);
    } finally { store.close(); }
  });

  it("splits a delta across two owners in proportion to their expectations", async () => {
    const store = await open();
    try {
      store.insert(rolling(10, "2026-09-06T12:00:00Z"));
      store.startLease("session-a", "claude-main:all", 30, 3_600_000, null, new Date("2026-09-06T12:00:00Z"));
      store.startLease("session-b", "claude-main:all", 10, 3_600_000, null, new Date("2026-09-06T12:00:00Z"));
      store.insert(rolling(30, "2026-09-06T12:30:00Z"));
      const rows = store.spendByOwner({ since: "2026-09-06T00:00:00Z" });
      expect(Object.fromEntries(rows.map((row) => [row.owner, Number(row.attributed_percent.toFixed(6))]))).toEqual({ "session-a": 15, "session-b": 5 });
      expect(rows.every((row) => row.confidence === 0.5)).toBe(true);
    } finally { store.close(); }
  });

  it("books movement with no lease open to unattributed", async () => {
    const store = await open();
    try {
      store.insert(rolling(10, "2026-09-06T12:00:00Z"));
      store.insert(rolling(18, "2026-09-06T12:30:00Z"));
      const rows = store.spendByOwner({ since: "2026-09-06T00:00:00Z" });
      expect(rows).toHaveLength(1);
      expect(rows[0].owner).toBe(UNATTRIBUTED_OWNER);
      expect(rows[0].attributed_percent).toBeCloseTo(8, 9);
      expect(rows[0].confidence).toBe(0.5);
    } finally { store.close(); }
  });

  it("treats a drop as a reset, never as negative spend, and resumes after it", async () => {
    const store = await open();
    try {
      store.startLease("session-a", "claude-main:all", null, 6 * 3_600_000, null, new Date("2026-09-06T12:00:00Z"));
      store.insert(rolling(60, "2026-09-06T12:00:00Z", "2026-09-06T13:00:00Z"));
      // The window reset: used falls back to 2 and the reset timestamp advances.
      store.insert(rolling(2, "2026-09-06T13:10:00Z", "2026-09-06T18:00:00Z"));
      store.insert(rolling(9, "2026-09-06T13:40:00Z", "2026-09-06T18:00:00Z"));
      const rows = store.spendByOwner({ since: "2026-09-06T00:00:00Z" });
      expect(rows).toHaveLength(1);
      // Only the post-reset 2 -> 9 movement is booked; the 60 -> 2 drop is not.
      expect(rows[0].attributed_percent).toBeCloseTo(7, 9);
      expect(rows[0].samples).toBe(1);
    } finally { store.close(); }
  });

  it("never records a soft, state, count or non-percent window", async () => {
    const store = await open();
    try {
      store.insert(rolling(10, "2026-09-06T12:00:00Z", "2026-09-06T17:00:00Z", { window: { kind: "rolling", minutes: 300, enforcement: "soft" } }));
      store.insert(rolling(40, "2026-09-06T12:30:00Z", "2026-09-06T17:00:00Z", { window: { kind: "rolling", minutes: 300, enforcement: "soft" } }));
      expect(store.spendByOwner({ since: "2026-09-06T00:00:00Z" })).toEqual([]);
    } finally { store.close(); }
  });

  it("prunes rows older than the retention on the next write", async () => {
    const store = await open();
    try {
      const old = new Date(Date.now() - (SPEND_LEDGER_RETENTION_DAYS + 2) * 86_400_000);
      const olderStill = new Date(old.getTime() - 30 * 60_000);
      store.insert(rolling(10, olderStill.toISOString(), "2026-12-01T00:00:00Z"));
      store.insert(rolling(20, old.toISOString(), "2026-12-01T00:00:00Z"));
      expect(store.spendByOwner()).toHaveLength(1);
      const now = new Date();
      const earlier = new Date(now.getTime() - 30 * 60_000);
      store.insert(rolling(30, earlier.toISOString(), "2026-12-01T00:00:00Z"));
      store.insert(rolling(35, now.toISOString(), "2026-12-01T00:00:00Z"));
      const rows = store.spendByOwner();
      // The pre-retention row was dropped by the write that followed it, so
      // only the recent 30 -> 35 delta survives; its 10 percent is gone.
      expect(rows).toHaveLength(1);
      expect(rows[0].attributed_percent).toBeCloseTo(5, 9);
      expect(rows[0].samples).toBe(1);
    } finally { store.close(); }
  });
});

describe("rate --owner", () => {
  it("annotates each line with that owner's attributed share of the same lookback", async () => {
    const store = await open();
    try {
      const now = new Date("2026-09-06T12:30:00Z");
      store.insert(rolling(10, "2026-09-06T12:00:00Z"));
      store.startLease("session-a", "claude-main:all", null, 3_600_000, null, new Date("2026-09-06T12:00:00Z"));
      store.insert(rolling(25, "2026-09-06T12:30:00Z"));
      const [line] = rateLines(store, "claude-main:all", 60, now, "session-a");
      expect(line.attributed_owner).toBe("session-a");
      expect(line.attributed_percent).toBeCloseTo(15, 9);
      expect(line.attributed_confidence).toBe(1);
      // Without an owner the line keeps its original shape.
      expect(rateLines(store, "claude-main:all", 60, now)[0].attributed_owner).toBeUndefined();
    } finally { store.close(); }
  });
});

describe("headroom spend", () => {
  it("prints one line per owner and window, and the same rows as JSON", async () => {
    const path = await home();
    const store = await HeadroomStore.open(path);
    try {
      store.insert(rolling(10, "2026-09-06T12:00:00Z"));
      store.startLease("session-a", "claude-main:all", null, 30 * 86_400_000, null, new Date("2026-09-06T12:00:00Z"));
      store.insert(rolling(25, "2026-09-06T12:30:00Z"));
    } finally { store.close(); }
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => { logged.push(String(value)); });
    const errored = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await withHeadroomHome(path, async () => {
        expect(await main(["spend", "--since", "365d"])).toBe(0);
        expect(await main(["spend", "--owner", "session-a", "--since", "365d", "--json"])).toBe(0);
      });
    } finally { log.mockRestore(); errored.mockRestore(); }
    expect(logged[0]).toContain("claude-main:all  5h  session-a");
    expect(logged[0]).toContain("confidence 1.00 (n=1)");
    const rows = JSON.parse(logged[1]) as Array<{ owner: string; attributed_percent: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].attributed_percent).toBeCloseTo(15, 9);
  });

  it("says so plainly when nothing has been attributed yet", async () => {
    const path = await home();
    const store = await HeadroomStore.open(path);
    store.close();
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => { logged.push(String(value)); });
    const errored = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try { await withHeadroomHome(path, async () => { expect(await main(["spend"])).toBe(0); }); }
    finally { log.mockRestore(); errored.mockRestore(); }
    expect(logged[0]).toMatch(/^no attributed spend since /);
  });
});

describe("quota_spend", () => {
  it("mirrors the CLI's rows over MCP, with no daemon", async () => {
    const path = await home();
    const store = await HeadroomStore.open(path);
    try {
      store.insert(rolling(10, "2026-09-06T12:00:00Z"));
      store.startLease("session-a", "claude-main:all", null, 30 * 86_400_000, null, new Date("2026-09-06T12:00:00Z"));
      store.insert(rolling(25, "2026-09-06T12:30:00Z"));
    } finally { store.close(); }
    const listed = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(((listed?.result as { tools: Array<{ name: string }> }).tools).map((item) => item.name)).toContain("quota_spend");
    const reply = await withHeadroomHome(path, () => handleMcp(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "quota_spend", arguments: { meter: "claude-main:all", since: "2026-01-01T00:00:00Z" } } }),
      async () => undefined,
    ));
    const result = (reply?.result as { structuredContent: { rows: Array<{ owner: string; attributed_percent: number; confidence: number }> } }).structuredContent;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].owner).toBe("session-a");
    expect(result.rows[0].attributed_percent).toBeCloseTo(15, 9);
    expect(result.rows[0].confidence).toBe(1);
  });

  it("refuses an argument its schema does not declare", async () => {
    const reply = await handleMcp(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "quota_spend", arguments: { meters: "claude-main:all" } } }),
      async () => undefined,
    );
    expect((reply?.error as { message: string }).message).toContain("unknown argument: meters");
  });
});

describe("spendLines", () => {
  it("labels the 5h and weekly windows the way rate does", () => {
    expect(spendLines([
      { meter_id: "m", window_minutes: 300, owner: "a", attributed_percent: 1.5, confidence: 1, samples: 2, from_at: "x", to_at: "y" },
      { meter_id: "m", window_minutes: 10_080, owner: "a", attributed_percent: 0.25, confidence: 0.5, samples: 1, from_at: "x", to_at: "y" },
    ])).toEqual([
      "m  5h  a  1.50%  confidence 1.00 (n=2)",
      "m  wk  a  0.25%  confidence 0.50 (n=1)",
    ]);
  });
});
