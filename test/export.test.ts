import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { assertWithinExportBound } from "../src/export.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-export-"));
  temporary.push(root);
  return join(root, ".headroom");
}

async function withHeadroomHome<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = path;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

function fresh(meterId: string, used: number, fetchedAt: string, overrides: Partial<Observation> = {}): Observation {
  return {
    principal_id: meterId.split(":")[0], meter_id: meterId, window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: "2026-12-01T00:00:00.000Z",
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...overrides,
  };
}

function failed(meterId: string, fetchedAt: string, reason: string): Observation {
  return {
    principal_id: meterId.split(":")[0], meter_id: meterId, window: null, quantity: null, resets_at: null,
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "estimated", freshness: "failed",
    confidence: 0, adapter_version: "fixture", upstream_schema_version: "fixture", reason,
  };
}

/** Two observations 30 minutes apart on claude-main:all (with a lease open
 * across the movement, so it lands in the spend ledger), one failed
 * windowless observation on claude-main:fable (so events has something to
 * report), all within the last hour of `now`. */
async function seed(now = new Date("2026-09-01T12:30:00.000Z")): Promise<string> {
  const path = await home();
  const store = await HeadroomStore.open(path);
  try {
    const first = new Date(now.getTime() - 30 * 60_000).toISOString();
    store.insert(fresh("claude-main:all", 10, first));
    store.startLease("session-a", "claude-main:all", 20, 30 * 86_400_000, null, new Date(first));
    store.insert(fresh("claude-main:all", 25, now.toISOString()));
    store.insert(failed("claude-main:fable", now.toISOString(), "transport error"));
  } finally { store.close(); }
  return path;
}

async function runExport(path: string, args: string[]): Promise<string[]> {
  const logged: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => { logged.push(String(value)); });
  try { await withHeadroomHome(path, async () => { expect(await main(["export", ...args])).toBe(0); }); }
  finally { log.mockRestore(); }
  return logged;
}

describe("headroom export (JSON)", () => {
  it("exports observations, events, spend, and leases as one document", async () => {
    const path = await seed();
    const [line] = await runExport(path, ["--since", "365d"]);
    const doc = JSON.parse(line) as {
      schema_version: number; exported_at: string; range: unknown;
      observations: Array<Record<string, unknown>>; events: unknown[]; spend: Array<Record<string, unknown>>; leases: unknown[];
    };
    expect(typeof doc.schema_version).toBe("number");
    expect(doc.schema_version).toBeGreaterThan(0);
    expect(typeof doc.exported_at).toBe("string");
    expect(doc.observations).toHaveLength(3);
    // Raw stored columns only -- no burn/empty_in_seconds/sustainable pace fields.
    expect(doc.observations[0]).not.toHaveProperty("burn_percent_per_hour");
    expect(doc.observations[0]).not.toHaveProperty("empty_in_seconds");
    expect(doc.events.length).toBeGreaterThan(0);
    expect(doc.spend).toHaveLength(1);
    expect(doc.spend[0]).toMatchObject({ meter_id: "claude-main:all", owner: "session-a" });
    expect(doc.spend[0].delta_percent).toBeCloseTo(15, 9);
    expect(doc.leases).toHaveLength(1);
  });

  it("applies the range filter", async () => {
    const path = await home();
    const store = await HeadroomStore.open(path);
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const middle = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const newest = new Date().toISOString();
    try {
      store.insert(fresh("claude-main:all", 5, old));
      store.insert(fresh("claude-main:all", 40, middle));
      store.insert(fresh("claude-main:all", 70, newest));
    } finally { store.close(); }
    const until = new Date(Date.now() - 3_600_000).toISOString();
    const [line] = await runExport(path, ["--kind", "observations", "--since", "7d", "--until", until]);
    const doc = JSON.parse(line) as { observations: Array<{ quantity: { used: number } }> };
    expect(doc.observations).toHaveLength(1);
    expect(doc.observations[0].quantity.used).toBe(40);
  });

  it("applies the meter and principal filters, and omits kinds that were not requested", async () => {
    const path = await seed();
    const [line] = await runExport(path, ["--kind", "observations", "--since", "365d", "--meter", "claude-main:all"]);
    const doc = JSON.parse(line) as Record<string, unknown>;
    const observations = doc.observations as Array<{ meter_id: string }>;
    expect(observations).toHaveLength(2);
    expect(observations.every((row) => row.meter_id === "claude-main:all")).toBe(true);
    expect(doc).not.toHaveProperty("events");
    expect(doc).not.toHaveProperty("spend");
    expect(doc).not.toHaveProperty("leases");

    const [narrowed] = await runExport(path, ["--kind", "observations", "--since", "365d", "--principal", "does-not-exist"]);
    expect((JSON.parse(narrowed) as { observations: unknown[] }).observations).toHaveLength(0);
  });

  it("writes the document to --out instead of stdout when given", async () => {
    const path = await seed();
    const outPath = join(path, "..", "export.json");
    const [line] = await runExport(path, ["--kind", "leases", "--since", "365d", "--out", outPath]);
    expect(line).toBe(`wrote ${outPath}`);
    const doc = JSON.parse(await readFile(outPath, "utf8")) as { leases: unknown[] };
    expect(doc.leases).toHaveLength(1);
  });
});

describe("headroom export (CSV)", () => {
  it("requires --out", async () => {
    const path = await seed();
    await withHeadroomHome(path, async () => {
      await expect(main(["export", "--format", "csv"])).rejects.toThrow("--out is required");
    });
  });

  it("writes one file per kind for --kind all, each with a header row", async () => {
    const path = await seed();
    const outBase = join(path, "..", "export.csv");
    await runExport(path, ["--since", "365d", "--format", "csv", "--out", outBase]);

    const observationsCsv = await readFile(join(path, "..", "export-observations.csv"), "utf8");
    const observationLines = observationsCsv.trim().split("\n");
    expect(observationLines[0]).toBe("id,principal_id,meter_id,window,quantity,resets_at,observed_at,fetched_at,source,truth,freshness,confidence,adapter_version,upstream_schema_version,reason,metadata");
    expect(observationLines).toHaveLength(4);

    const spendCsv = await readFile(join(path, "..", "export-spend.csv"), "utf8");
    expect(spendCsv.trim().split("\n")).toHaveLength(2);

    const leaseCsv = await readFile(join(path, "..", "export-leases.csv"), "utf8");
    expect(leaseCsv.trim().split("\n")).toHaveLength(2);

    const eventsCsv = await readFile(join(path, "..", "export-events.csv"), "utf8");
    expect(eventsCsv.trim().split("\n").length).toBeGreaterThanOrEqual(2);
  });

  it("writes exactly the given path for a single --kind, with no suffix", async () => {
    const path = await seed();
    const outPath = join(path, "..", "leases-only.csv");
    await runExport(path, ["--kind", "leases", "--since", "365d", "--format", "csv", "--out", outPath]);
    const csv = await readFile(outPath, "utf8");
    expect(csv.trim().split("\n")).toHaveLength(2);
  });

  it("quotes a reason containing a comma and a double quote per RFC 4180", async () => {
    const path = await home();
    const store = await HeadroomStore.open(path);
    try { store.insert(failed("claude-main:all", "2026-09-01T12:00:00.000Z", 'contains, a "quote"')); }
    finally { store.close(); }
    const outPath = join(path, "..", "observations.csv");
    await runExport(path, ["--kind", "observations", "--since", "365d", "--format", "csv", "--out", outPath]);
    const lines = (await readFile(outPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"contains, a ""quote"""');
  });
});

describe("assertWithinExportBound", () => {
  it("refuses a count over the limit and suggests narrowing the range", () => {
    expect(() => assertWithinExportBound(1_000_001)).toThrow(/1000000 row bound/);
    expect(() => assertWithinExportBound(1_000_001)).toThrow(/narrow --since\/--until/);
  });

  it("accepts a count at or under the limit", () => {
    expect(() => assertWithinExportBound(1_000_000)).not.toThrow();
    expect(() => assertWithinExportBound(3, 5)).not.toThrow();
    expect(() => assertWithinExportBound(6, 5)).toThrow(/5 row bound/);
  });
});
