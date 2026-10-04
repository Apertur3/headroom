/**
 * A lane blocked by its exhausted weekly (recorded live 2026-09-29) is a
 * `failed` row that is still a vendor answer. It must reach served status
 * even when an older fresh row exists for the same window, in the text
 * status, the dashboard and MCP quota_status, with no number and an additive
 * JSON shape.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollAccounts } from "../src/collector.js";
import { renderDashboard, type DashboardModel } from "../src/dashboard.js";
import { nativeEnginePath, runNativeEngine } from "../src/engine/native/run.js";
import { directStatus } from "../src/mcp.js";
import { withStatusInfo } from "../src/pace.js";
import { defaultPolicy } from "../src/policy.js";
import { renderStatus } from "../src/status-view.js";
import { HeadroomStore } from "../src/store.js";
import type { Observation } from "../src/types.js";
import { engineRowsFromRecord, loadRecord } from "./helpers/antigravity-fixtures.js";

vi.mock("../src/engine/native/run.js", () => ({ NATIVE_ENGINE_TIMEOUT_MS: 90_000, nativeEnginePath: vi.fn(), runNativeEngine: vi.fn() }));

const NOW = "2026-09-29T20:20:00Z";
const BLOCKED = "5h blocked until 2026-09-30T20:21:49Z (weekly exhausted)";
const temporary: string[] = [];
const previousHome = process.env.HEADROOM_HOME;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function polled(): Promise<{ root: string; observations: Observation[]; result: Awaited<ReturnType<typeof pollAccounts>> }> {
  const record = (await loadRecord("2026-09-29-weekly-exhausted.json")).principals[0];
  const root = await mkdtemp(join(tmpdir(), "headroom-blocked-status-"));
  temporary.push(root);
  await writeFile(join(root, "accounts.toml"), `[[accounts]]\nname = "agy"\nvendor = "antigravity"\nlocation = "agy"\nadapter = "native-ts"\n`, { mode: 0o600 });
  process.env.HEADROOM_HOME = root;
  vi.mocked(nativeEnginePath).mockResolvedValue("/fake/engine");
  vi.mocked(runNativeEngine).mockReset().mockImplementation(async () => engineRowsFromRecord(record, "agy", NOW));
  const result = await pollAccounts(undefined, { nativeEngineAvailable: true, daemonOwnsAntigravity: true, antigravityLoginState: "logged_in" });
  return { root, observations: result.observations.filter((row) => row.principal_id === "agy"), result };
}

/** What the store held before 0.2.2: a fresh 5h row for the gemini lane. */
function olderFresh5h(rows: Observation[]): Observation[] {
  const at = "2026-09-29T10:00:00.000Z";
  return rows.filter((row) => row.meter_id === "agy:gemini" && row.window?.minutes === 300)
    .map((row) => ({ ...row, freshness: "fresh" as const, quantity: { used: 0, limit: 100, remaining: 100, unit: "percent" as const }, reason: undefined, metadata: {}, observed_at: at, fetched_at: at }));
}

describe("blocked Antigravity lane in served status", () => {
  it("shows the blocked 5h lane in text status, the dashboard and MCP quota_status, without a number", async () => {
    const { root, observations, result } = await polled();
    const store = await HeadroomStore.open(root);
    const now = new Date("2026-09-29T20:21:00Z");
    try {
      store.insertPoll(olderFresh5h(observations));
      store.insertPoll(observations);
      const raw = store.latestPerWindow();
      const gemini5h = raw.find((row) => row.meter_id === "agy:gemini" && row.window?.minutes === 300);
      expect(gemini5h).toMatchObject({ freshness: "failed", quantity: null, metadata: { lane_state: "blocked_by_weekly" } });
      const served = withStatusInfo(raw, store.burnRateFor(raw, now), store.lastKnownFor(raw, now), 15, now);

      for (const form of ["plain", "grouped"] as const) {
        const text = renderStatus({ observations: served, policy: defaultPolicy, now }, { form, width: 120, verbose: false, color: false, direct: false } as never).join("\n");
        expect(text, form).toContain(form === "plain" ? BLOCKED : "until 2026-09-30T20:21:49Z");
        expect(text, form).toContain("blocked");
      }

      const model: DashboardModel = { now, version: "0.0.0", direct: false, policy: defaultPolicy, vendors: new Map([["agy", "antigravity"]]), observations: served, burns: {}, resetSeen: {}, events: [], leases: [], notices: [], planDowngraded: [] };
      expect(renderDashboard(model, { width: 200, height: 40, verbose: false, eventsWide: false, scroll: 0 }).join("\n")).toContain(BLOCKED);
    } finally { store.close(); }

    const direct = await directStatus({ now: () => now, poll: async () => result }) as { observations: Array<Observation & { blocked_summary?: string }> };
    const blocked = direct.observations.find((row) => row.meter_id === "agy:gemini" && row.window?.minutes === 300)!;
    expect(blocked).toMatchObject({ freshness: "failed", quantity: null, blocked_summary: BLOCKED, metadata: { lane_state: "blocked_by_weekly", blocked_until: "2026-09-30T20:21:49Z" } });
    expect(JSON.stringify(blocked)).not.toMatch(/"used"/);
    // Additive: every other row keeps its shape, with no blocked_summary.
    expect(direct.observations.filter((row) => row.blocked_summary)).toHaveLength(1);
  });
});
