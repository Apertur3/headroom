/**
 * The Codex normalizer (codex-usage-events.ts, already reviewed and tested
 * on its own) wired end to end: schema migration to v2 and then v3,
 * `headroom usage import --format codex` against a synthetic Codex session
 * file, idempotent re-import, Claude/Codex coexistence in one `usage.db`,
 * import-status rendering both vendors, and persistence of Codex rate-limit
 * observations (v3's `usage_rate_limit_observations` table).
 *
 * Every fixture here is synthetic: response ids, message ids, timestamps and
 * token counts are invented for the test and correspond to no real Codex or
 * Claude Code session.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { main } from "../src/cli.js";
import { UsageStore, CURRENT_USAGE_SCHEMA_VERSION, CODEX_UNAVAILABLE_MODEL } from "../src/usage-store.js";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...p: unknown[]): Record<string, unknown> | undefined;
      all(...p: unknown[]): Record<string, unknown>[];
      run(...p: unknown[]): unknown;
    };
    close(): void;
  };
};

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

function captureOutput(): { stdout: string[]; restore: () => void } {
  const stdout: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => { stdout.push(String(line)); });
  return { stdout, restore: () => { logSpy.mockRestore(); } };
}

async function setupHome(prefix: string): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return { root, home };
}

/** Synthetic Codex session-file line matching `token_usage_record`'s shape
 * (see codex-usage-events.ts's own field inventory) -- never a capture of a
 * real Codex session. */
function codexLine(overrides: { responseId?: string; ts?: string; usage?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    type: "token_usage_record",
    timestamp: overrides.ts ?? "2026-09-21T10:00:00.000Z",
    payload: {
      response_id: overrides.responseId ?? "resp_test_001",
      usage: overrides.usage ?? {
        input_tokens: 100,
        cached_input_tokens: 50,
        cache_write_input_tokens: 0,
        output_tokens: 75,
        reasoning_output_tokens: 25,
        total_tokens: 175,
      },
    },
  });
}

/** Synthetic Claude assistant transcript line, same shape used across the
 * existing usage-import tests. */
function claudeLine(overrides: { id?: string; ts?: string } = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: overrides.ts ?? "2026-09-20T10:00:00.000Z",
    message: {
      id: overrides.id ?? "msg_1",
      model: "claude-sonnet-5",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

describe("usage.db schema migration to v3", () => {
  it("a fresh install lands directly on v3 with every Codex column and the rate-limit-observations table present", async () => {
    const { home } = await setupHome("codex-collector-fresh-");
    const store = (await UsageStore.open({ home, create: true }))!;
    try {
      expect(CURRENT_USAGE_SCHEMA_VERSION).toBe(4);
      expect(store.schemaVersion()).toBe(CURRENT_USAGE_SCHEMA_VERSION);
    } finally {
      store.close();
    }

    const raw = new DatabaseSync(join(home, "usage.db"));
    try {
      const columns = raw.prepare("PRAGMA table_info(usage_identities)").all().map((row) => String(row.name));
      for (const expected of [
        "vendor", "model_attribution",
        "cached_input_value", "cached_input_diagnosis",
        "cache_write_value", "cache_write_diagnosis",
        "reasoning_value", "reasoning_diagnosis",
        "total_value", "total_diagnosis",
        "consistency_flags",
      ]) {
        expect(columns).toContain(expected);
      }
      const indexed = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'usage_identities_group'").get();
      expect(String(indexed?.sql)).toContain("vendor");

      const rateLimitTable = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_rate_limit_observations'").get();
      expect(rateLimitTable).toBeDefined();
      const rateLimitColumns = raw.prepare("PRAGMA table_info(usage_rate_limit_observations)").all().map((row) => String(row.name));
      expect(rateLimitColumns).toEqual(expect.arrayContaining([
        "identity_key", "source_key", "principal_key", "vendor", "slot", "observed_at_ms",
        "used_percent_value", "used_percent_diagnosis", "window_minutes_value", "window_minutes_diagnosis",
        "resets_at_ms_value", "resets_at_ms_diagnosis", "created_at",
      ]));
    } finally {
      raw.close();
    }
  });

  it("a v1 database upgrades all the way to v3 in place, keeping its existing Claude row intact", async () => {
    const { home } = await setupHome("codex-collector-upgrade-");
    const dbPath = join(home, "usage.db");

    // Hand-built v1 database: the exact shape this build shipped before
    // Codex support (no vendor/model_attribution/Codex counter columns).
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE usage_cursors (
        cursor_key TEXT PRIMARY KEY, source_key TEXT NOT NULL, principal_key TEXT NOT NULL,
        job_key TEXT, job_conflict INTEGER NOT NULL DEFAULT 0, dev TEXT, ino TEXT,
        generation INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
        byte_offset INTEGER NOT NULL DEFAULT 0, prefix_len INTEGER NOT NULL DEFAULT 0,
        prefix_hash TEXT, boundary_hash TEXT, discard_pending INTEGER NOT NULL DEFAULT 0,
        discard_bytes INTEGER NOT NULL DEFAULT 0, at_eof INTEGER NOT NULL DEFAULT 0,
        pending_partial INTEGER NOT NULL DEFAULT 0, budget_exhausted INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok', interrupt_reason TEXT,
        total_bytes_read INTEGER NOT NULL DEFAULT 0, last_scan_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE usage_path_bindings (path_key TEXT PRIMARY KEY, source_key TEXT NOT NULL, principal_key TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE usage_identities (
        identity_key TEXT PRIMARY KEY, source_key TEXT NOT NULL, principal_key TEXT NOT NULL,
        model TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, sequence INTEGER NOT NULL,
        input_tokens_value INTEGER, input_tokens_diagnosis TEXT,
        output_tokens_value INTEGER, output_tokens_diagnosis TEXT,
        cache_read_value INTEGER, cache_read_diagnosis TEXT,
        cache_creation_value INTEGER, cache_creation_diagnosis TEXT,
        cache_breakdown_present INTEGER NOT NULL DEFAULT 0,
        cache_5m_value INTEGER, cache_5m_diagnosis TEXT,
        cache_1h_value INTEGER, cache_1h_diagnosis TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX usage_identities_group ON usage_identities(principal_key, source_key, model);
      CREATE TABLE usage_identity_jobs (identity_key TEXT PRIMARY KEY, job_key TEXT, conflicted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE usage_quarantine (identity_key TEXT PRIMARY KEY, source_key TEXT NOT NULL, principal_key TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE usage_counters (cursor_key TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cursor_key, kind));
    `);
    raw.prepare("INSERT INTO usage_meta (key, value) VALUES ('alias_salt', ?)").run("a".repeat(64));
    raw.prepare(`INSERT INTO usage_identities
        (identity_key, source_key, principal_key, model, observed_at_ms, sequence, input_tokens_value, input_tokens_diagnosis, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .run("e".repeat(32), "b".repeat(32), "c".repeat(32), "claude-sonnet-5", 1, 0, 42, null, "2026-01-01T00:00:00.000Z");
    raw.exec("PRAGMA user_version = 1;");
    raw.close();
    await chmod(dbPath, 0o600);

    const store = (await UsageStore.open({ home, create: true }))!;
    try {
      expect(store.schemaVersion()).toBe(CURRENT_USAGE_SCHEMA_VERSION);
      const totals = store.groupedTotals();
      expect(totals).toHaveLength(1);
      expect(totals[0].vendor).toBe("claude");
      expect(totals[0].inputTokens.total).toBe(42);
      // The v2 -> v3 step ran too, not just v1 -> v2: the new table exists
      // and is queryable through the store's own accessor.
      expect(store.rateLimitObservationCount()).toBe(0);
    } finally {
      store.close();
    }

    const rawAfter = new DatabaseSync(dbPath);
    try {
      const columns = rawAfter.prepare("PRAGMA table_info(usage_identities)").all().map((row) => String(row.name));
      expect(columns).toContain("vendor");
      expect(columns).toContain("consistency_flags");
      const row = rawAfter.prepare("SELECT vendor FROM usage_identities WHERE identity_key = ?").get("e".repeat(32));
      expect(row?.vendor).toBe("claude");
      const rateLimitTable = rawAfter.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_rate_limit_observations'").get();
      expect(rateLimitTable).toBeDefined();
    } finally {
      rawAfter.close();
    }
  });

  it("a v2 database (this build's previous shape) upgrades to v3 in place, adding only the new table", async () => {
    const { home } = await setupHome("codex-collector-v2-upgrade-");
    const dbPath = join(home, "usage.db");

    // Hand-built v2 database: the exact shape this build shipped before the
    // rate-limit-observations table existed (PR #57's Codex identity support,
    // no usage_rate_limit_observations table yet).
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE usage_cursors (
        cursor_key TEXT PRIMARY KEY, source_key TEXT NOT NULL, principal_key TEXT NOT NULL,
        job_key TEXT, job_conflict INTEGER NOT NULL DEFAULT 0, dev TEXT, ino TEXT,
        generation INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
        byte_offset INTEGER NOT NULL DEFAULT 0, prefix_len INTEGER NOT NULL DEFAULT 0,
        prefix_hash TEXT, boundary_hash TEXT, discard_pending INTEGER NOT NULL DEFAULT 0,
        discard_bytes INTEGER NOT NULL DEFAULT 0, at_eof INTEGER NOT NULL DEFAULT 0,
        pending_partial INTEGER NOT NULL DEFAULT 0, budget_exhausted INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok', interrupt_reason TEXT,
        total_bytes_read INTEGER NOT NULL DEFAULT 0, last_scan_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE usage_path_bindings (path_key TEXT PRIMARY KEY, source_key TEXT NOT NULL, principal_key TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE usage_identities (
        identity_key TEXT PRIMARY KEY, source_key TEXT NOT NULL, principal_key TEXT NOT NULL,
        model TEXT NOT NULL, vendor TEXT NOT NULL DEFAULT 'claude', model_attribution TEXT,
        observed_at_ms INTEGER NOT NULL, sequence INTEGER NOT NULL,
        input_tokens_value INTEGER, input_tokens_diagnosis TEXT,
        output_tokens_value INTEGER, output_tokens_diagnosis TEXT,
        cache_read_value INTEGER, cache_read_diagnosis TEXT,
        cache_creation_value INTEGER, cache_creation_diagnosis TEXT,
        cache_breakdown_present INTEGER NOT NULL DEFAULT 0,
        cache_5m_value INTEGER, cache_5m_diagnosis TEXT,
        cache_1h_value INTEGER, cache_1h_diagnosis TEXT,
        cached_input_value INTEGER, cached_input_diagnosis TEXT,
        cache_write_value INTEGER, cache_write_diagnosis TEXT,
        reasoning_value INTEGER, reasoning_diagnosis TEXT,
        total_value INTEGER, total_diagnosis TEXT,
        consistency_flags TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX usage_identities_group ON usage_identities(vendor, principal_key, source_key, model);
      CREATE TABLE usage_identity_jobs (identity_key TEXT PRIMARY KEY, job_key TEXT, conflicted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE usage_quarantine (identity_key TEXT PRIMARY KEY, source_key TEXT NOT NULL, principal_key TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE usage_counters (cursor_key TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cursor_key, kind));
    `);
    raw.prepare("INSERT INTO usage_meta (key, value) VALUES ('alias_salt', ?)").run("a".repeat(64));
    raw.prepare(`INSERT INTO usage_identities
        (identity_key, source_key, principal_key, model, vendor, observed_at_ms, sequence, input_tokens_value, input_tokens_diagnosis, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run("f".repeat(32), "b".repeat(32), "c".repeat(32), "claude-sonnet-5", "claude", 1, 0, 7, null, "2026-01-01T00:00:00.000Z");
    raw.exec("PRAGMA user_version = 2;");
    raw.close();
    await chmod(dbPath, 0o600);

    const store = (await UsageStore.open({ home, create: true }))!;
    try {
      expect(store.schemaVersion()).toBe(CURRENT_USAGE_SCHEMA_VERSION);
      // The pre-existing v2 row is untouched by the purely additive v2 -> v3
      // step (no ALTER TABLE on usage_identities this time, only a new table).
      const totals = store.groupedTotals();
      expect(totals).toHaveLength(1);
      expect(totals[0].inputTokens.total).toBe(7);
      expect(store.rateLimitObservationCount()).toBe(0);
    } finally {
      store.close();
    }

    const rawAfter = new DatabaseSync(dbPath);
    try {
      const rateLimitTable = rawAfter.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_rate_limit_observations'").get();
      expect(rateLimitTable).toBeDefined();
    } finally {
      rawAfter.close();
    }
  });
});

describe("Codex rate-limit observations are persisted (PR #57's TODO)", () => {
  it("persists a rate-limit-only event_msg line's observations and reports them in import-status", async () => {
    const { root, home } = await setupHome("codex-collector-ratelimit-persist-");
    const session = join(root, "session.jsonl");
    const rateLimitLine = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-21T10:00:00.000Z",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 42, window_minutes: 10080, resets_at: 1893456000 },
          secondary: { used_percent: 3, window_minutes: 300, resets_at: 1893410000 },
        },
      },
    });
    await writeFile(session, `${rateLimitLine}\n`);

    await withHeadroomHome(home, async () => {
      const out = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "codex-main", "--path", session, "--format", "codex", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(out.stdout[0]);
        expect(payload.counters["skipped:rate_limit_only"]).toBe(1);
        expect(payload.counters.rate_limit_observed).toBe(2);
      } finally {
        out.restore();
      }

      const store = (await UsageStore.open({ home, create: false }))!;
      try {
        expect(store.rateLimitObservationCount()).toBe(2);
        const observations = store.rateLimitObservations();
        expect(observations).toEqual(expect.arrayContaining([
          expect.objectContaining({ vendor: "codex", slot: "primary", usedPercent: { value: 42, diagnosis: null }, windowMinutes: { value: 10080, diagnosis: null } }),
          expect.objectContaining({ vendor: "codex", slot: "secondary", usedPercent: { value: 3, diagnosis: null }, windowMinutes: { value: 300, diagnosis: null } }),
        ]));
      } finally {
        store.close();
      }
    });
  });

  it("re-importing the identical bytes is a no-op for the persisted observations (content-hash dedup, not row count)", async () => {
    const { root, home } = await setupHome("codex-collector-ratelimit-dedup-");
    const session = join(root, "session.jsonl");
    const rateLimitLine = JSON.stringify({
      type: "event_msg", timestamp: "2026-09-21T10:00:00.000Z",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1893456000 } } },
    });
    await writeFile(session, `${rateLimitLine}\n`);

    await withHeadroomHome(home, async () => {
      await main(["usage", "import", "--source", "codex-cli", "--principal", "codex-main", "--path", session, "--format", "codex"]);
      const store1 = (await UsageStore.open({ home, create: false }))!;
      try { expect(store1.rateLimitObservationCount()).toBe(1); } finally { store1.close(); }

      // Second run on the same file: bytesReadThisRun is 0 (nothing new to
      // read), so the collector's Codex branch never re-parses the line --
      // the observation count must stay exactly 1, not double.
      await main(["usage", "import", "--source", "codex-cli", "--principal", "codex-main", "--path", session, "--format", "codex"]);
      const store2 = (await UsageStore.open({ home, create: false }))!;
      try { expect(store2.rateLimitObservationCount()).toBe(1); } finally { store2.close(); }
    });
  });
});

describe("headroom usage import --format codex", () => {
  it("imports a synthetic Codex session file and reports accepted counters", async () => {
    const { root, home } = await setupHome("codex-collector-import-");
    const session = join(root, "session.jsonl");
    await writeFile(session, `${codexLine()}\n`);

    await withHeadroomHome(home, async () => {
      const out = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "codex-main", "--path", session, "--format", "codex", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(out.stdout[0]);
        expect(payload.kind).toBe("imported");
        expect(payload.format).toBe("codex");
        expect(payload.counters.accepted_new).toBe(1);
        expect(payload.finished).toBe(true);
      } finally {
        out.restore();
      }
    });
  });

  it("stores Codex rows under the codex:unavailable model sentinel with the codex vendor and its own counters", async () => {
    const { home } = await setupHome("codex-collector-sentinel-");
    const store = (await UsageStore.open({ home, create: true }))!;
    try {
      const outcome = store.applyAndPersistCodex({
        identityKey: "1".repeat(32),
        principalKey: "2".repeat(32),
        sourceKey: "3".repeat(32),
        vendor: "codex",
        model: null,
        modelAttribution: "unavailable_in_record",
        observedAtMs: Date.parse("2026-09-21T10:00:00.000Z"),
        sequence: 0,
        usage: {
          input_tokens: { value: 100, diagnosis: null },
          output_tokens: { value: 75, diagnosis: null },
          cached_input_tokens: { value: 50, diagnosis: null },
          reasoning_output_tokens: { value: 25, diagnosis: null },
          cache_write_input_tokens: { value: 0, diagnosis: null },
          total_tokens: { value: 175, diagnosis: null },
        },
        consistency: [],
        evidence: "usage_record_visible",
      });
      expect(outcome).toBe("accepted_new");

      const totals = store.groupedTotals();
      expect(totals).toHaveLength(1);
      expect(totals[0].vendor).toBe("codex");
      expect(totals[0].model).toBe(CODEX_UNAVAILABLE_MODEL);
      expect(totals[0].inputTokens.total).toBe(100);
      expect(totals[0].outputTokens.total).toBe(75);
      expect(totals[0].cachedInputTokens?.total).toBe(50);
      expect(totals[0].cacheWriteTokens?.total).toBe(0);
      expect(totals[0].reasoningTokens?.total).toBe(25);
      expect(totals[0].totalTokens?.total).toBe(175);
    } finally {
      store.close();
    }
  });

  it("re-importing the same Codex session reads 0 new bytes and stays idempotent", async () => {
    const { root, home } = await setupHome("codex-collector-idempotent-");
    const session = join(root, "session.jsonl");
    await writeFile(session, `${codexLine()}\n`);

    await withHeadroomHome(home, async () => {
      await main(["usage", "import", "--source", "codex-cli", "--principal", "codex-main", "--path", session, "--format", "codex"]);
      const out = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "codex-main", "--path", session, "--format", "codex", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(out.stdout[0]);
        expect(payload.bytesReadThisRun).toBe(0);
        expect(payload.counters).toEqual({});
      } finally {
        out.restore();
      }
    });
  });

  it("counts a rate-limit-only line separately, without creating an identity", async () => {
    const { root, home } = await setupHome("codex-collector-ratelimit-");
    const session = join(root, "session.jsonl");
    const rateLimitLine = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-21T10:00:00.000Z",
      payload: {
        type: "token_count",
        rate_limits: { primary: { used_percent: 42, window_minutes: 10080, resets_at: 1893456000 } },
      },
    });
    await writeFile(session, `${rateLimitLine}\n`);

    await withHeadroomHome(home, async () => {
      const out = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "codex-main", "--path", session, "--format", "codex", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(out.stdout[0]);
        expect(payload.counters["skipped:rate_limit_only"]).toBe(1);
        expect(Object.keys(payload.counters).some((k) => k.startsWith("accepted") || k.startsWith("quarantined"))).toBe(false);
      } finally {
        out.restore();
      }
    });
  });
});

describe("headroom usage import --format auto", () => {
  it("detects a Claude Code transcript file without --format claude and imports it normally", async () => {
    const { root, home } = await setupHome("codex-collector-auto-claude-");
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${claudeLine()}\n`);

    await withHeadroomHome(home, async () => {
      const out = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "claude-code", "--principal", "shared-principal", "--path", transcript, "--format", "auto", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(out.stdout[0]);
        expect(payload.format).toBe("auto");
        expect(payload.counters.accepted_new).toBe(1);
      } finally {
        out.restore();
      }

      const store = (await UsageStore.open({ home, create: false }))!;
      try {
        const totals = store.groupedTotals();
        expect(totals).toHaveLength(1);
        expect(totals[0].vendor).toBe("claude");
        expect(totals[0].model).toBe("claude-sonnet-5");
      } finally {
        store.close();
      }
    });
  });

  it("detects a Codex session file without --format codex and imports it normally, including its rate-limit observations", async () => {
    const { root, home } = await setupHome("codex-collector-auto-codex-");
    const session = join(root, "session.jsonl");
    const rateLimitLine = JSON.stringify({
      type: "event_msg", timestamp: "2026-09-21T10:05:00.000Z",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: 15, window_minutes: 300, resets_at: 1893456000 } } },
    });
    await writeFile(session, `${codexLine()}\n${rateLimitLine}\n`);

    await withHeadroomHome(home, async () => {
      const out = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "codex-main", "--path", session, "--format", "auto", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(out.stdout[0]);
        expect(payload.format).toBe("auto");
        expect(payload.counters.accepted_new).toBe(1);
        expect(payload.counters["skipped:rate_limit_only"]).toBe(1);
        expect(payload.counters.rate_limit_observed).toBe(1);
      } finally {
        out.restore();
      }

      const store = (await UsageStore.open({ home, create: false }))!;
      try {
        const totals = store.groupedTotals();
        expect(totals).toHaveLength(1);
        expect(totals[0].vendor).toBe("codex");
        expect(totals[0].model).toBe(CODEX_UNAVAILABLE_MODEL);
        expect(store.rateLimitObservationCount()).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  it("detects each line independently within one file, correctly routing an interleaved Claude line and a Codex line", async () => {
    // Not a realistic transcript (a real file is one vendor's shape
    // throughout), but this is exactly what "per line, not per file"
    // detection buys: a batch that happens to mix shapes is still routed
    // correctly line by line, rather than assuming the whole file matches
    // whichever line was sniffed first.
    const { root, home } = await setupHome("codex-collector-auto-mixed-");
    const mixed = join(root, "mixed.jsonl");
    await writeFile(mixed, `${claudeLine({ id: "msg_mixed_1" })}\n${codexLine({ responseId: "resp_mixed_1" })}\n`);

    await withHeadroomHome(home, async () => {
      const code = await main(["usage", "import", "--source", "mixed-source", "--principal", "mixed-principal", "--path", mixed, "--format", "auto"]);
      expect(code).toBe(0);

      const store = (await UsageStore.open({ home, create: false }))!;
      try {
        const totals = store.groupedTotals();
        const vendors = totals.map((t) => t.vendor).sort();
        expect(vendors).toEqual(["claude", "codex"]);
      } finally {
        store.close();
      }
    });
  });

  it("falls back to the Claude normalizer (and its own rejection reasons) for a line whose format cannot be told apart", async () => {
    const { root, home } = await setupHome("codex-collector-auto-unknown-");
    const session = join(root, "session.jsonl");
    // Neither a `message` nor a `payload` wrapper, and a `type` outside both
    // vocabularies: genuinely unclassifiable.
    const unknownLine = JSON.stringify({ type: "something_else", timestamp: "2026-09-21T10:00:00.000Z", data: 1 });
    await writeFile(session, `${unknownLine}\n`);

    await withHeadroomHome(home, async () => {
      const out = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "unknown-source", "--principal", "unknown-principal", "--path", session, "--format", "auto", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(out.stdout[0]);
        // Routed to the Claude normalizer, which skips an unrecognized
        // `type` rather than rejecting it -- the same outcome `--format
        // claude` (or no --format at all) would produce for this line.
        expect(payload.counters["skipped:unrecognized_record_type"]).toBe(1);
      } finally {
        out.restore();
      }
    });
  });
});

describe("Claude and Codex imports coexist in one database", () => {
  it("import both formats without cross-vendor identity collision", async () => {
    const { root, home } = await setupHome("codex-collector-coexist-");
    const claudeTranscript = join(root, "claude.jsonl");
    const codexSession = join(root, "codex.jsonl");
    await writeFile(claudeTranscript, `${claudeLine()}\n`);
    await writeFile(codexSession, `${codexLine()}\n`);

    await withHeadroomHome(home, async () => {
      const importClaude = await main(["usage", "import", "--source", "claude-code", "--principal", "shared-principal", "--path", claudeTranscript]);
      const importCodex = await main(["usage", "import", "--source", "codex-cli", "--principal", "shared-principal", "--path", codexSession, "--format", "codex"]);
      expect(importClaude).toBe(0);
      expect(importCodex).toBe(0);

      const out = captureOutput();
      try {
        const code = await main(["usage", "import-status", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(out.stdout[0]);
        expect(payload.totals).toHaveLength(2);
        const vendors = (payload.totals as Array<{ vendor: string }>).map((t) => t.vendor).sort();
        expect(vendors).toEqual(["claude", "codex"]);
        const claudeTotal = (payload.totals as Array<{ vendor: string; model: string; inputTokens: { total: number } }>).find((t) => t.vendor === "claude")!;
        const codexTotal = (payload.totals as Array<{ vendor: string; model: string; inputTokens: { total: number } }>).find((t) => t.vendor === "codex")!;
        expect(claudeTotal.model).toBe("claude-sonnet-5");
        expect(codexTotal.model).toBe(CODEX_UNAVAILABLE_MODEL);
        expect(claudeTotal.inputTokens.total).toBe(100);
        expect(codexTotal.inputTokens.total).toBe(100);
      } finally {
        out.restore();
      }
    });
  });
});

describe("headroom usage import-status shows both vendors (human view)", () => {
  it("renders a vendor=claude line and a vendor=codex line with Codex-only counters", async () => {
    const { root, home } = await setupHome("codex-collector-status-human-");
    const claudeTranscript = join(root, "claude.jsonl");
    const codexSession = join(root, "codex.jsonl");
    await writeFile(claudeTranscript, `${claudeLine()}\n`);
    await writeFile(codexSession, `${codexLine()}\n`);

    await withHeadroomHome(home, async () => {
      await main(["usage", "import", "--source", "claude-code", "--principal", "shared-principal", "--path", claudeTranscript]);
      await main(["usage", "import", "--source", "codex-cli", "--principal", "shared-principal", "--path", codexSession, "--format", "codex"]);

      const out = captureOutput();
      try {
        const code = await main(["usage", "import-status"]);
        expect(code).toBe(0);
        expect(out.stdout.some((line) => line.includes("vendor=claude") && line.includes("model=claude-sonnet-5") && line.includes("cacheRead="))).toBe(true);
        expect(out.stdout.some((line) => line.includes("vendor=codex") && line.includes(`model=${CODEX_UNAVAILABLE_MODEL}`) && line.includes("cachedInput="))).toBe(true);
      } finally {
        out.restore();
      }
    });
  });
});
