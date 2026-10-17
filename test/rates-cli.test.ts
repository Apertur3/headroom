/**
 * `headroom rates` end to end: seeds real `headroom.db` meter observations
 * (via HeadroomStore.insert, the same helper shape test/cli-pacing.test.ts
 * uses) and imports synthetic Claude transcript lines into `usage.db` (via
 * `headroom usage import`), then runs `headroom rates` through `main()` and
 * checks the fit, the insufficient-data refusal, the drift event, and both
 * the `--json` and dense/`--agent` output shapes.
 *
 * Every fixture is synthetic: ids, timestamps and token counts are invented
 * for this test and correspond to no real session or account. Clock-adjacent
 * assertions are anchored to `Date.now() + offset`, like
 * test/cli-pacing.test.ts's own fixtures, so this test stays valid however
 * long a run has been going (see test/setup-isolation.ts for the pinned TZ
 * this and every other test file runs under).
 */
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { handleMcp } from "../src/mcp.js";
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

async function seededHome(prefix: string): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return { root, home };
}

function captureOutput(): { stdout: string[]; restore: () => void } {
  const stdout: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { stdout.push(String(line)); });
  return { stdout, restore: () => spy.mockRestore() };
}

const HOUR = 3_600_000;

function at(offsetMs: number): string { return new Date(Date.now() + offsetMs).toISOString(); }

function fiveHour(used: number, fetchedAtOffsetMs: number, meterId = "claude-main:all"): Observation {
  const fetchedAt = at(fetchedAtOffsetMs);
  return {
    principal_id: "claude-main", meter_id: meterId, window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: at(fetchedAtOffsetMs + HOUR),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

/** Synthetic Claude assistant transcript line: `outputTokens` is the only
 * varying counter, so the fitted rate for every other class comes out at 0
 * and the recovered output rate is directly checkable against `k`. */
function assistantLine(timestampIso: string, outputTokens: number, model = "claude-sonnet-5", id: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: timestampIso,
    message: { id, model, usage: { input_tokens: 0, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

/** Builds `count` consecutive meter observations (`count - 1` intervals)
 * starting `startOffsetMs` in the past, each interval hourMs apart, whose
 * cumulative percent grows by `k * outputTokens` per interval -- and the
 * matching transcript lines (one per interval, timestamped at its
 * midpoint) that a `headroom usage import` run turns into the token counts
 * the rate learner regresses against. */
function buildCleanSeries(startOffsetMs: number, count: number, k: number, startingUsed = 0, idPrefix = "msg"): { observations: Observation[]; lines: string[] } {
  const observations: Observation[] = [];
  const lines: string[] = [];
  let used = startingUsed;
  for (let i = 0; i < count; i++) {
    const offset = startOffsetMs + i * HOUR;
    observations.push(fiveHour(used, offset));
    if (i > 0) {
      const outputTokens = 1000 * i;
      const deltaPercent = k * outputTokens;
      used += deltaPercent;
      // Overwrite the just-pushed observation for this step with the
      // updated cumulative percent (pushed before `used` was updated above,
      // since observation i's own reading already reflects interval i's usage).
      observations[i] = fiveHour(used, offset);
      const midpointIso = at(offset - HOUR / 2);
      lines.push(assistantLine(midpointIso, outputTokens, "claude-sonnet-5", `${idPrefix}-${i}`));
    }
  }
  return { observations, lines };
}

describe("headroom rates", () => {
  it("fits a clean synthetic output-token rate, refuses insufficient data for an unrelated model, then reports drift after a differently-priced batch", async () => {
    const { root, home } = await seededHome("rates-cli-");
    await withHeadroomHome(home, async () => {
      const store = await HeadroomStore.open(home);
      // Batch 1: 9 intervals between 18h and 9h ago, k1 = 0.0001 -> 100
      // points per 1,000,000 output tokens.
      const batch1 = buildCleanSeries(-18 * HOUR, 10, 0.0001, 0, "b1");
      for (const observation of batch1.observations) store.insert(observation);
      store.close();

      const transcript1 = join(root, "transcript1.jsonl");
      await writeFile(transcript1, `${batch1.lines.join("\n")}\n`);
      const import1 = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "test", "--principal", "claude-main", "--path", transcript1, "--json"]);
        expect(code).toBe(0);
      } finally { import1.restore(); }

      const firstRun = captureOutput();
      let firstPayload: { rates: Array<Record<string, unknown>> };
      try {
        const code = await main(["rates", "--meter", "claude-main:all", "--model", "claude-sonnet-5", "--since", "20h", "--json"]);
        expect(code).toBe(0);
        firstPayload = JSON.parse(firstRun.stdout[0]);
      } finally { firstRun.restore(); }

      expect(firstPayload.rates).toHaveLength(1);
      const firstFit = firstPayload.rates[0];
      expect(firstFit.status).toBe("fit");
      expect(firstFit.sample_count).toBe(9);
      const firstRate = firstFit.rate_per_million_tokens as Record<string, number>;
      expect(firstRate.output).toBeCloseTo(100, 2);
      expect(firstRate.fresh_input).toBeCloseTo(0, 6);
      expect(firstFit.coverage).toBeCloseTo(1, 2);
      expect(firstFit.last_changed_at).toBeNull(); // first fit ever: nothing to compare against

      // An unrelated model with zero imported usage refuses outright.
      const insufficientRun = captureOutput();
      try {
        await main(["rates", "--meter", "claude-main:all", "--model", "claude-opus-5", "--since", "20h", "--json"]);
        const payload = JSON.parse(insufficientRun.stdout[0]);
        expect(payload.rates[0]).toMatchObject({ status: "insufficient_data", sample_count: 0, min_samples: 8 });
      } finally { insufficientRun.restore(); }

      // Batch 2: 9 more intervals in the last 9h, k2 = 0.0005 -> 500
      // points per 1,000,000 tokens -- a 5x, well-above-threshold change in
      // the same model's rate.
      const store2 = await HeadroomStore.open(home);
      const lastUsed = batch1.observations[batch1.observations.length - 1].quantity!.used;
      const batch2 = buildCleanSeries(-9 * HOUR, 10, 0.0005, lastUsed, "b2");
      for (const observation of batch2.observations) store2.insert(observation);
      store2.close();

      const transcript2 = join(root, "transcript2.jsonl");
      await writeFile(transcript2, `${batch2.lines.join("\n")}\n`);
      const import2 = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "test", "--principal", "claude-main", "--path", transcript2, "--json"]);
        expect(code).toBe(0);
      } finally { import2.restore(); }

      // Narrowing --since to 9h scopes both the meter history and the
      // imported-usage lookup to batch 2 only, isolating its own clean fit
      // from batch 1's (see this file's module doc).
      const secondRun = captureOutput();
      let secondPayload: { rates: Array<Record<string, unknown>> };
      try {
        const code = await main(["rates", "--meter", "claude-main:all", "--model", "claude-sonnet-5", "--since", "9h", "--json"]);
        expect(code).toBe(0);
        secondPayload = JSON.parse(secondRun.stdout[0]);
      } finally { secondRun.restore(); }

      const secondFit = secondPayload.rates[0];
      expect(secondFit.status).toBe("fit");
      const secondRate = secondFit.rate_per_million_tokens as Record<string, number>;
      expect(secondRate.output).toBeCloseTo(500, 2);
      expect(secondFit.last_changed_at).not.toBeNull();

      // Dense/--agent output carries the same numbers in fixed field order.
      const agentRun = captureOutput();
      try {
        const code = await main(["rates", "--meter", "claude-main:all", "--model", "claude-sonnet-5", "--since", "9h", "--agent"]);
        expect(code).toBe(0);
        const line = agentRun.stdout.find((l) => l.startsWith("meter="));
        expect(line).toContain("model=claude-sonnet-5");
        expect(line).toContain("status=fit");
        expect(line).toMatch(/output=500\.000/);
        expect(line).not.toContain("lastChanged=never");
      } finally { agentRun.restore(); }
    });
  });

  it("reports no usage data before headroom usage import has ever run, without creating usage.db", async () => {
    const { home } = await seededHome("rates-cli-empty-");
    await withHeadroomHome(home, async () => {
      const out = captureOutput();
      try {
        const code = await main(["rates"]);
        expect(code).toBe(0);
        expect(out.stdout.some((line) => line.includes("no usage data imported yet"))).toBe(true);
      } finally { out.restore(); }
      await expect(access(join(home, "usage.db"))).rejects.toThrow();
    });
  });

  it("reports no percent meters tracked when usage.db exists but this meter has none", async () => {
    const { root, home } = await seededHome("rates-cli-no-meter-");
    await withHeadroomHome(home, async () => {
      // Bring usage.db into existence via a real import, with no matching
      // headroom.db meter observations at all.
      const transcript = join(root, "transcript.jsonl");
      await writeFile(transcript, `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`);
      const importRun = captureOutput();
      try { expect(await main(["usage", "import", "--source", "test", "--principal", "claude-main", "--path", transcript, "--json"])).toBe(0); }
      finally { importRun.restore(); }

      const out = captureOutput();
      try {
        const code = await main(["rates"]);
        expect(code).toBe(0);
        expect(out.stdout.some((line) => line.includes("no percent meters tracked yet"))).toBe(true);
      } finally { out.restore(); }
    });
  });

  it("quota_rates is advertised in tools/list and answers directly (never through the daemon)", async () => {
    const { home } = await seededHome("rates-mcp-");
    await withHeadroomHome(home, async () => {
      const listed = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      const names = ((listed?.result as { tools: Array<{ name: string }> }).tools).map((item) => item.name);
      expect(names).toContain("quota_rates");

      const call = async (): Promise<Record<string, unknown>> => {
        const reply = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quota_rates", arguments: {} } }));
        return (reply?.result as { structuredContent: Record<string, unknown> }).structuredContent;
      };
      const result = await call();
      expect(result).toMatchObject({ source: "direct", rates: [] });
      expect(typeof result.contract).toBe("string");
    });
  });
});
