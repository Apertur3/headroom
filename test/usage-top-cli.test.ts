/**
 * `headroom usage top` end to end: imports synthetic Claude transcript lines
 * (one bound to a `--job` alias, one not) and checks that attribution
 * reports `estimated_points: null` before any rate has been learned, then a
 * real number once `headroom rates` has fit one, split correctly by
 * `--by model` and `--by session` (usage.db's `--job` alias -- see
 * usage-top.ts's module doc for why "session" means "job" here).
 *
 * Every fixture is synthetic: ids, timestamps and token counts are invented
 * for this test.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
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

function fiveHour(used: number, fetchedAtOffsetMs: number): Observation {
  const fetchedAt = at(fetchedAtOffsetMs);
  return {
    principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: at(fetchedAtOffsetMs + HOUR),
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

function assistantLine(timestampIso: string, outputTokens: number, id: string, model = "claude-sonnet-5"): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: timestampIso,
    message: { id, model, usage: { input_tokens: 0, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

describe("headroom usage top", () => {
  it("reports null estimates before a rate exists, then real per-model and per-session estimates once headroom rates has fit one", async () => {
    const { root, home } = await seededHome("usage-top-cli-");
    await withHeadroomHome(home, async () => {
      // 9 clean claude-sonnet-5 intervals over the last 9h, k = 0.0001 ->
      // 100 points per 1,000,000 output tokens (same shape as
      // rates-cli.test.ts). Only the last five (i = 5..9, tokens
      // 5000..9000) fall inside `usage top`'s own default 5h window.
      const store = await HeadroomStore.open(home);
      let used = 0;
      const lines: string[] = [];
      for (let i = 0; i <= 9; i++) {
        const offset = -9 * HOUR + i * HOUR;
        if (i > 0) {
          const outputTokens = 1000 * i;
          used += 0.0001 * outputTokens;
          lines.push(assistantLine(at(offset - HOUR / 2), outputTokens, `lane-a-${i}`));
        }
        store.insert(fiveHour(used, offset));
      }
      store.close();

      // A second, differently-modeled identity within the fit window: this
      // both (a) exercises usage top's own per-model split and its "unknown
      // rate" path for a model headroom rates never fit, and (b) keeps
      // claude-sonnet-5's own fit clean by making the interval it lands in
      // mixed-model (dropped from every model's fit -- see
      // rate-learner.ts's attributeIntervals), rather than silently
      // inflating claude-sonnet-5's own token count for that interval.
      const laneBTranscript = join(root, "lane-b.jsonl");
      await writeFile(laneBTranscript, `${assistantLine(at(-30 * 60_000), 500, "lane-b-1", "claude-opus-5")}\n`);
      const laneATranscript = join(root, "lane-a.jsonl");
      await writeFile(laneATranscript, `${lines.join("\n")}\n`);

      const importA = captureOutput();
      try { expect(await main(["usage", "import", "--source", "test", "--principal", "claude-main", "--path", laneATranscript, "--job", "lane-a", "--json"])).toBe(0); }
      finally { importA.restore(); }
      const importB = captureOutput();
      try { expect(await main(["usage", "import", "--source", "test", "--principal", "claude-main", "--path", laneBTranscript, "--json"])).toBe(0); }
      finally { importB.restore(); }

      // Before any rate fit exists, points are never fabricated.
      const beforeFit = captureOutput();
      try {
        expect(await main(["usage", "top", "--window", "5h", "--by", "model", "--json"])).toBe(0);
        const payload = JSON.parse(beforeFit.stdout[0]);
        expect(payload.rows).toHaveLength(2);
        for (const row of payload.rows) expect(row.estimated_points).toBeNull();
      } finally { beforeFit.restore(); }

      const fitRun = captureOutput();
      try { expect(await main(["rates", "--meter", "claude-main:all", "--model", "claude-sonnet-5", "--since", "10h", "--json"])).toBe(0); }
      finally { fitRun.restore(); }

      const byModel = captureOutput();
      try {
        expect(await main(["usage", "top", "--window", "5h", "--by", "model", "--json"])).toBe(0);
        const payload = JSON.parse(byModel.stdout[0]);
        expect(payload.rows).toHaveLength(2);
        const sonnetRow = payload.rows.find((row: Record<string, unknown>) => row.model === "claude-sonnet-5");
        const opusRow = payload.rows.find((row: Record<string, unknown>) => row.model === "claude-opus-5");
        // 5,000 + 6,000 + 7,000 + 8,000 + 9,000 = 35,000 tokens at 100
        // points per 1,000,000 tokens.
        expect(sonnetRow.estimated_points).toBeCloseTo(3.5, 2);
        // claude-opus-5 has no rate fit at all (its only interval was
        // dropped as mixed-model) -- never a fabricated number.
        expect(opusRow.estimated_points).toBeNull();
      } finally { byModel.restore(); }

      const bySession = captureOutput();
      try {
        expect(await main(["usage", "top", "--window", "5h", "--by", "session", "--json"])).toBe(0);
        const payload = JSON.parse(bySession.stdout[0]);
        expect(payload.rows).toHaveLength(2);
        const unattributed = payload.rows.find((row: Record<string, unknown>) => row.session === "unattributed");
        const laneA = payload.rows.find((row: Record<string, unknown>) => row.session !== "unattributed");
        // "session" here is usage.db's own opaque per-database hash of the
        // --job alias (see usage-top.ts's module doc) -- never the raw
        // "lane-a" text, which is exactly usage.db's own no-free-text-alias
        // policy (see usage-store.ts) applied to this view.
        expect(laneA.session).toMatch(/^[0-9a-f]{32}$/);
        expect(laneA.estimated_points).toBeCloseTo(3.5, 2);
        // The unattributed (lane-b) usage is claude-opus-5, which has no
        // rate fit.
        expect(unattributed.estimated_points).toBeNull();
      } finally { bySession.restore(); }

      // Dense human output carries the same shape.
      const denseRun = captureOutput();
      try {
        expect(await main(["usage", "top", "--window", "5h", "--by", "model"])).toBe(0);
        expect(denseRun.stdout.some((line) => line.startsWith("principal=claude-main") && line.includes("model=claude-sonnet-5") && line.includes("estPoints="))).toBe(true);
      } finally { denseRun.restore(); }
    });
  });

  it("reports no usage data before anything has been imported", async () => {
    const { home } = await seededHome("usage-top-cli-empty-");
    await withHeadroomHome(home, async () => {
      const out = captureOutput();
      try {
        const code = await main(["usage", "top"]);
        expect(code).toBe(0);
        expect(out.stdout.some((line) => line.includes("no usage data imported yet"))).toBe(true);
      } finally { out.restore(); }
    });
  });
});
