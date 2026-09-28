import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeUnmarkedDaemonStatus } from "../src/status-normalization.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";

// node:sqlite has no published types in this codebase's target lib; a
// structural minimum is all this file needs to poke at PRAGMA user_version
// and compare raw file bytes.
interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(): Record<string, unknown> | undefined };
  close(): void;
}
const RawDatabaseSync = (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => RawDatabase }).DatabaseSync;

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" }, resets_at: "2026-09-03T17:00:00Z",
    observed_at: "2026-09-03T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z", source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture", ...overrides,
  };
}

describe("normalizeUnmarkedDaemonStatus", () => {
  it("returns observations unchanged when every row already carries status_enriched_at", async () => {
    const marked = observation({ status_enriched_at: "2026-09-03T12:05:00Z" });
    const result = await normalizeUnmarkedDaemonStatus([marked], 15);
    expect(result).toEqual([marked]);
  });

  it("enriches an unmarked row from a real store, read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-status-normalization-")); temporary.push(root);
    const home = join(root, ".headroom");
    await withHeadroomHome(home, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
      const store = await HeadroomStore.open(home);
      store.insert(observation());
      store.close();

      const unmarked = observation({ fetched_at: "2026-09-03T11:00:00Z" }); // 1h old, staleness_minutes 15
      const [result] = await normalizeUnmarkedDaemonStatus([unmarked], 15);
      expect(result.status_enriched_at).toBe(new Date("2026-09-03T12:00:00Z").toISOString());
      expect(result.freshness).toBe("stale");
      // Proves the read-only store connection actually queried history,
      // rather than silently failing open and falling back to the empty
      // maps the "cannot be opened at all" test below exercises: the fresh
      // row inserted above is the real last-known reading for this meter
      // and window.
      expect(result.last_known).toMatchObject({ used_percent: 20 });
    });
  });

  it("never migrates or writes an older-schema database file while reading it -- HeadroomStore.openReadOnly, not open", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-status-normalization-ro-")); temporary.push(root);
    const home = join(root, ".headroom");
    await withHeadroomHome(home, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
      // Build a real, current-schema database with one observation, then roll
      // its PRAGMA user_version back to simulate an older daemon's database
      // file -- exactly the file a newer CLI must be able to read without
      // upgrading it out from under that daemon.
      const store = await HeadroomStore.open(home);
      store.insert(observation());
      store.close();

      const dbPath = join(home, "headroom.db");
      const rollback = new RawDatabaseSync(dbPath);
      rollback.exec("PRAGMA user_version = 1");
      rollback.close();

      const before = await readFile(dbPath);
      const beforeHash = createHash("sha256").update(before).digest("hex");
      const beforeVersionDb = new RawDatabaseSync(dbPath, { readOnly: true });
      const beforeVersion = beforeVersionDb.prepare("PRAGMA user_version").get()?.user_version;
      beforeVersionDb.close();
      expect(beforeVersion).toBe(1);

      const unmarked = observation({ fetched_at: "2026-09-03T11:00:00Z" });
      const [result] = await normalizeUnmarkedDaemonStatus([unmarked], 15);
      // The read genuinely happened against this file (not a silent open
      // failure that fell back to the empty maps) -- it found the row
      // inserted above as this meter/window's last-known reading.
      expect(result.last_known).toMatchObject({ used_percent: 20 });

      const after = await readFile(dbPath);
      const afterHash = createHash("sha256").update(after).digest("hex");
      expect(afterHash).toBe(beforeHash);
      const afterVersionDb = new RawDatabaseSync(dbPath, { readOnly: true });
      const afterVersion = afterVersionDb.prepare("PRAGMA user_version").get()?.user_version;
      afterVersionDb.close();
      expect(afterVersion).toBe(1);
    });
  });

  it("fails closed -- no throw, no fabricated last_known or burn -- when the store cannot be opened at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-status-normalization-missing-")); temporary.push(root);
    const home = join(root, ".headroom-never-created");
    await withHeadroomHome(home, async () => {
      const unmarked = observation({ fetched_at: "2026-09-03T11:00:00Z" });
      const [result] = await normalizeUnmarkedDaemonStatus([unmarked], 15);
      expect(result.status_enriched_at).toBeDefined();
      expect(result.last_known).toBeNull();
      expect(result.burn_percent_per_hour).toBeNull();
    });
  });
});
