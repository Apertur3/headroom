/**
 * usage-store.ts invariants. Every fixture here is synthetic: the ids,
 * aliases and "secret" strings are invented for the test and correspond to no
 * real account, path or credential.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, chmod, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { UsageStore, UsagePersistenceError, NewerUsageSchemaError, safeSum, isKnownClaudeModel, CURRENT_USAGE_SCHEMA_VERSION } from "../src/usage-store.js";
import type { CursorRow } from "../src/usage-store.js";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite") as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { get(...p: unknown[]): Record<string, unknown> | undefined }; close(): void } };

const IDENTITY = "a".repeat(32);
const SOURCE = "b".repeat(32);
const PRINCIPAL = "c".repeat(32);
const JOB = "d".repeat(32);
const OTHER_JOB = "e".repeat(32);
const MODEL = "claude-sonnet-5";
const TS = Date.parse("2026-01-01T00:00:00Z");

type Snapshot = Parameters<UsageStore["applyAndPersist"]>[0];

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    identityKey: IDENTITY,
    sourceKey: SOURCE,
    principalKey: PRINCIPAL,
    model: MODEL,
    observedAtMs: TS,
    sequence: 0,
    usage: {
      input_tokens: { value: 10, diagnosis: null },
      output_tokens: { value: 20, diagnosis: null },
      cache_read_input_tokens: { value: 30, diagnosis: null },
      cache_creation_input_tokens: { value: 40, diagnosis: null },
      cache_creation_breakdown: null,
    },
    ...overrides,
  } as Snapshot;
}

function cursor(overrides: Partial<CursorRow> = {}): CursorRow {
  return {
    cursorKey: "f".repeat(32),
    sourceKey: SOURCE,
    principalKey: PRINCIPAL,
    jobKey: null,
    jobConflict: false,
    dev: "1",
    ino: "2",
    generation: 1,
    revision: 1,
    byteOffset: 0,
    prefixLen: 0,
    prefixHash: null,
    boundaryHash: null,
    discardPending: false,
    discardBytes: 0,
    atEof: true,
    pendingPartial: false,
    budgetExhausted: false,
    status: "ok",
    interruptReason: null,
    totalBytesRead: 0,
    lastScanAt: null,
    createdAt: new Date(TS).toISOString(),
    ...overrides,
  };
}

describe("UsageStore", () => {
  let root: string;
  let store: UsageStore | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "usage-store-"));
    await chmod(root, 0o700);
  });

  afterEach(async () => {
    store?.close();
    store = undefined;
    await rm(root, { recursive: true, force: true });
  });

  describe("open", () => {
    it("creates no state at all for a status-style read of a home that has none", async () => {
      const missing = join(root, "nothing-here");
      expect(await UsageStore.open({ home: missing, create: false })).toBeUndefined();
      await expect(stat(missing)).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    });

    it("leaves an uninitialized database uninitialized when create is false", async () => {
      const dbPath = join(root, "usage.db");
      await writeFile(dbPath, "", { mode: 0o600 });
      expect(await UsageStore.open({ home: root, create: false })).toBeUndefined();
      expect((await stat(dbPath)).size).toBe(0);
    });

    it("initializes schema and salt together when create is true", async () => {
      store = await UsageStore.open({ home: root, create: true });
      expect(store!.schemaVersion()).toBe(CURRENT_USAGE_SCHEMA_VERSION);
      store!.close();
      store = undefined;
      const raw = new DatabaseSync(join(root, "usage.db"));
      const salt = raw.prepare("SELECT value FROM usage_meta WHERE key = 'alias_salt'").get();
      raw.close();
      expect(String(salt?.value)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses a database newer than this build without writing to it", async () => {
      store = await UsageStore.open({ home: root, create: true });
      store!.close();
      store = undefined;
      const dbPath = join(root, "usage.db");
      const raw = new DatabaseSync(dbPath);
      raw.exec(`PRAGMA user_version = ${CURRENT_USAGE_SCHEMA_VERSION + 7};`);
      raw.close();
      const before = await readFile(dbPath);

      await expect(UsageStore.open({ home: root, create: true })).rejects.toBeInstanceOf(NewerUsageSchemaError);
      expect(await readFile(dbPath)).toEqual(before);
    });

    it("initializes once when two connections open the same new database at once", async () => {
      const [a, b] = await Promise.all([
        UsageStore.open({ home: root, create: true }),
        UsageStore.open({ home: root, create: true }),
      ]);
      try {
        expect(a!.schemaVersion()).toBe(CURRENT_USAGE_SCHEMA_VERSION);
        expect(b!.schemaVersion()).toBe(CURRENT_USAGE_SCHEMA_VERSION);
        // One salt, so both connections agree on every alias hash.
        expect(a!.hashAlias("source", "alias-one")).toBe(b!.hashAlias("source", "alias-one"));
        a!.putCursor(cursor());
        expect(b!.getCursor("f".repeat(32))).toBeDefined();
      } finally {
        a?.close();
        b?.close();
      }
    });

    it("keeps alias hashes stable within a database and unlinkable across databases", async () => {
      store = await UsageStore.open({ home: root, create: true });
      const first = store!.hashAlias("source", "alias-one");
      store!.close();
      store = await UsageStore.open({ home: root, create: false });
      expect(store!.hashAlias("source", "alias-one")).toBe(first);
      store!.close();
      store = undefined;

      const otherRoot = await mkdtemp(join(tmpdir(), "usage-store-"));
      await chmod(otherRoot, 0o700);
      const other = await UsageStore.open({ home: otherRoot, create: true });
      expect(other!.hashAlias("source", "alias-one")).not.toBe(first);
      other!.close();
      await rm(otherRoot, { recursive: true, force: true });
    });
  });

  describe("persistence boundary validation", () => {
    beforeEach(async () => {
      store = await UsageStore.open({ home: root, create: true });
    });

    it("rejects every kind of untrusted field before any statement runs", async () => {
      const bad: Snapshot[] = [
        snapshot({ model: "NOT-A-CLAUDE-MODEL-canary" }),
        snapshot({ identityKey: "not hex" }),
        snapshot({ sourceKey: "../../etc/passwd" }),
        snapshot({ observedAtMs: 9e15 }),
        snapshot({ observedAtMs: -1 }),
        snapshot({ sequence: 1.5 as unknown as number }),
        snapshot({ usage: { ...snapshot().usage, input_tokens: { value: -5, diagnosis: null } } }),
        snapshot({ usage: { ...snapshot().usage, output_tokens: { value: null, diagnosis: "made_up" as never } } }),
      ];
      for (const candidate of bad) {
        expect(() => store!.applyAndPersist(candidate)).toThrow(UsagePersistenceError);
      }
      expect(store!.groupedTotals()).toEqual([]);
      expect(store!.quarantineCount()).toBe(0);
      const bytes = await readFile(join(root, "usage.db"), "utf8");
      expect(bytes).not.toContain("NOT-A-CLAUDE-MODEL-canary");
      expect(bytes).not.toContain("etc/passwd");
    });

    it("rejects a counter kind that is not a fixed outcome label", () => {
      expect(() => store!.incrementCounter("f".repeat(32), 'rejected:{"secret":"canary"}')).toThrow(UsagePersistenceError);
      expect(() => store!.incrementCounter("not-a-key", "accepted_new")).toThrow(UsagePersistenceError);
      store!.putCursor(cursor());
      store!.incrementCounter("f".repeat(32), "rejected:malformed_json");
      expect(store!.counters()).toEqual([{ cursorKey: "f".repeat(32), kind: "rejected:malformed_json", count: 1 }]);
    });

    it("rejects a cursor row carrying anything but opaque keys and bounded numbers", () => {
      expect(() => store!.putCursor(cursor({ cursorKey: "/home/test/.claude/projects/x.jsonl" }))).toThrow(UsagePersistenceError);
      expect(() => store!.putCursor(cursor({ prefixHash: "not-a-hash" }))).toThrow(UsagePersistenceError);
      expect(() => store!.putCursor(cursor({ byteOffset: -1 }))).toThrow(UsagePersistenceError);
      expect(() => store!.putCursor(cursor({ status: "weird" as never }))).toThrow(UsagePersistenceError);
      expect(() => store!.putCursor(cursor({ interruptReason: "because" as never }))).toThrow(UsagePersistenceError);
      expect(store!.allCursors()).toEqual([]);
    });

    it("only admits model ids Anthropic actually ships", () => {
      for (const model of ["claude-sonnet-5", "claude-opus-5", "claude-fable-5-1", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229", "claude-haiku-4-5-20251001"]) {
        expect(isKnownClaudeModel(model)).toBe(true);
      }
      for (const model of ["gpt-4o", "claude-", "claude-sonnet-5; DROP TABLE", "claude-sonnet-5 ", "sk-ant-api03-AAAA", "claude-" + "x".repeat(60)]) {
        expect(isKnownClaudeModel(model)).toBe(false);
      }
    });
  });

  describe("cursor compare-and-set", () => {
    beforeEach(async () => {
      store = await UsageStore.open({ home: root, create: true });
    });

    it("reports a baseline as current only while nothing else has written", () => {
      const key = "f".repeat(32);
      expect(store!.cursorRevisionMatches(key, null)).toBe(true);
      expect(store!.cursorRevisionMatches(key, 1)).toBe(false);
      store!.putCursor(cursor({ revision: 1 }));
      expect(store!.cursorRevisionMatches(key, null)).toBe(false);
      expect(store!.cursorRevisionMatches(key, 1)).toBe(true);
      store!.putCursor(cursor({ revision: 2, byteOffset: 10 }));
      expect(store!.cursorRevisionMatches(key, 1)).toBe(false);
      expect(store!.getCursor(key)!.byteOffset).toBe(10);
    });
  });

  describe("quarantine scope", () => {
    beforeEach(async () => {
      store = await UsageStore.open({ home: root, create: true });
    });

    it("counts quarantined identities under their own source and principal only", () => {
      store!.applyAndPersist(snapshot());
      store!.applyAndPersist(snapshot({ usage: { ...snapshot().usage, input_tokens: { value: 11, diagnosis: null } } }));

      expect(store!.quarantineCount()).toBe(1);
      expect(store!.quarantineCount({ sourceKeyHash: SOURCE, principalKeyHash: PRINCIPAL })).toBe(1);
      expect(store!.quarantineCount({ sourceKeyHash: "9".repeat(32) })).toBe(0);
      expect(store!.quarantineCount({ principalKeyHash: "9".repeat(32) })).toBe(0);
    });
  });

  describe("job linkage", () => {
    beforeEach(async () => {
      store = await UsageStore.open({ home: root, create: true });
    });

    it("drops the association rather than letting two jobs claim one identity", () => {
      expect(store!.bindIdentityJob(IDENTITY, JOB)).toBe("bound");
      expect(store!.bindIdentityJob(IDENTITY, JOB)).toBe("unchanged");
      expect(store!.identityJob(IDENTITY)).toEqual({ jobKey: JOB, conflicted: false });

      expect(store!.bindIdentityJob(IDENTITY, OTHER_JOB)).toBe("conflict");
      expect(store!.identityJob(IDENTITY)).toEqual({ jobKey: null, conflicted: true });
      expect(store!.jobConflictCount()).toBe(1);

      // A conflicted identity stays conflicted: neither claimant wins later.
      expect(store!.bindIdentityJob(IDENTITY, JOB)).toBe("already_conflicted");
      expect(store!.identityJob(IDENTITY)).toEqual({ jobKey: null, conflicted: true });
    });
  });

  describe("path binding", () => {
    beforeEach(async () => {
      store = await UsageStore.open({ home: root, create: true });
    });

    it("pins the first source and principal for a path and never rewrites them", () => {
      const pathKey = store!.hashPath("/synthetic/fixture/a.jsonl");
      store!.bindPath({ pathKey, sourceKey: SOURCE, principalKey: PRINCIPAL, createdAt: "2026-01-01T00:00:00.000Z" });
      store!.bindPath({ pathKey, sourceKey: "9".repeat(32), principalKey: "8".repeat(32), createdAt: "2026-01-02T00:00:00.000Z" });
      expect(store!.getPathBinding(pathKey)).toMatchObject({ sourceKey: SOURCE, principalKey: PRINCIPAL });
    });

    it("does not persist the raw path", async () => {
      const secretPath = "/synthetic/fixture/CANARY-PATH-SEGMENT/a.jsonl";
      store!.bindPath({ pathKey: store!.hashPath(secretPath), sourceKey: SOURCE, principalKey: PRINCIPAL, createdAt: "2026-01-01T00:00:00.000Z" });
      store!.close();
      store = undefined;
      expect(await readFile(join(root, "usage.db"), "utf8")).not.toContain("CANARY-PATH-SEGMENT");
    });
  });

  describe("aggregation", () => {
    beforeEach(async () => {
      store = await UsageStore.open({ home: root, create: true });
    });

    it("never reports missing counters as an observed zero", () => {
      const missing = {
        input_tokens: { value: null, diagnosis: null },
        output_tokens: { value: null, diagnosis: null },
        cache_read_input_tokens: { value: null, diagnosis: null },
        cache_creation_input_tokens: { value: null, diagnosis: null },
        cache_creation_breakdown: null,
      } as Snapshot["usage"];
      store!.applyAndPersist(snapshot({ usage: missing }));
      const totals = store!.groupedTotals();
      expect(totals).toHaveLength(1);
      expect(totals[0].identityCount).toBe(1);
      expect(totals[0].inputTokens).toEqual({ total: null, overflow: false, known: 0, unknown: 1 });

      store!.applyAndPersist(snapshot({ identityKey: "1".repeat(32), observedAtMs: TS + 1 }));
      const mixed = store!.groupedTotals()[0];
      expect(mixed.inputTokens).toEqual({ total: 10, overflow: false, known: 1, unknown: 1 });
    });

    it("refuses to hand back a lossy total past the safe integer range", () => {
      expect(safeSum([])).toEqual({ total: null, overflow: false, known: 0, unknown: 0 });
      expect(safeSum([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])).toEqual({ total: null, overflow: true, known: 2, unknown: 0 });
      expect(safeSum([Number.MAX_SAFE_INTEGER, null])).toEqual({ total: Number.MAX_SAFE_INTEGER, overflow: false, known: 1, unknown: 1 });
    });

    it("groups by principal, source and model and filters by scope", () => {
      store!.applyAndPersist(snapshot());
      store!.applyAndPersist(snapshot({ identityKey: "2".repeat(32), model: "claude-opus-5" }));
      expect(store!.groupedTotals().map((g) => g.model)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
      expect(store!.groupedTotals({ sourceKeyHash: "9".repeat(32) })).toEqual([]);
    });
  });
});
