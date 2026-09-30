/**
 * One fixture per row of the Antigravity root-cause history (2026-09-29).
 * Each recorded or synthetic `observe --record` answer runs through the shared
 * lane classifier and through the path that really receives it (the daemon's
 * local read via pollAccounts, and/or the remote adapter), and asserts every
 * lane's state, that no "placeholder" appears anywhere, and that one bad lane
 * leaves the other lanes fresh.
 *
 * History rows without a payload of their own (09-12 packaging, 09-23 orphan
 * agy, 09-27 leaked PTYs) are process and packaging faults, not lane states.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeAntigravity, observationsFromAntigravityQuota, antigravityPayloadFromQuota } from "../src/adapters/antigravity.js";
import { antigravityLaneObservations, antigravityPayloadFromEngineRows, classifyAntigravityLanes, type AntigravityLaneState } from "../src/antigravity-lanes.js";
import { findStaleLanes } from "../src/canary.js";
import { pollAccounts } from "../src/collector.js";
import { nativeEnginePath, runNativeEngine } from "../src/engine/native/run.js";
import { gateFor } from "../src/orchestrator-reads.js";
import { canConsume, defaultPolicy, freshnessGate, isAcceptedLaneReading, paceDecision } from "../src/policy.js";
import { formatMeters } from "../src/status-view.js";
import { HeadroomStore } from "../src/store.js";
import type { Account, Observation, ProviderAccount } from "../src/types.js";
import { ENGINE_ERROR_TEXT, engineRowsFromRecord, loadRecord, remoteBodyFromRecord, type RecordPrincipal } from "./helpers/antigravity-fixtures.js";

vi.mock("../src/engine/native/run.js", () => ({ NATIVE_ENGINE_TIMEOUT_MS: 90_000, nativeEnginePath: vi.fn(), runNativeEngine: vi.fn() }));

const PRINCIPAL = "agy";
const ACCOUNT: ProviderAccount = { name: PRINCIPAL, vendor: "antigravity", location: "agy", adapter: "native-ts" };
const NOW = "2026-09-29T20:20:00Z";
type LaneKey = "gemini 5h" | "gemini weekly" | "claude-gpt 5h" | "claude-gpt weekly";
type Expected = Record<LaneKey, AntigravityLaneState>;

const temporary: string[] = [];
const previousHome = process.env.HEADROOM_HOME;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function principalFrom(name: string): Promise<RecordPrincipal> {
  const file = await loadRecord(name);
  expect(file.principals).toHaveLength(1);
  return file.principals[0];
}

function laneRow(rows: Observation[], lane: LaneKey): Observation | undefined {
  const [meter, window] = lane.split(" ");
  return rows.find((row) => row.meter_id === `${PRINCIPAL}:${meter}` && row.window?.minutes === (window === "5h" ? 300 : 10_080));
}

function statesOf(classification: ReturnType<typeof classifyAntigravityLanes>): Expected {
  return Object.fromEntries(classification.lanes.map((lane) => [`${lane.meter} ${lane.minutes === 300 ? "5h" : "weekly"}`, lane.state])) as Expected;
}

/** Every lane row matches its state's observation shape, fresh lanes carry a
 * real number, and nothing anywhere says "placeholder". */
function expectLaneRows(rows: Observation[], expected: Expected): void {
  for (const [lane, state] of Object.entries(expected) as [LaneKey, AntigravityLaneState][]) {
    const row = laneRow(rows, lane);
    expect(row, lane).toBeDefined();
    if (state === "fresh") expect(row, lane).toMatchObject({ freshness: "fresh", quantity: { unit: "percent" } });
    else if (state === "blocked_by_weekly") expect(row, lane).toMatchObject({ freshness: "failed", quantity: null, metadata: { lane_state: "blocked_by_weekly" } });
    else if (state === "missing" && lane.endsWith("5h")) expect(row, lane).toMatchObject({ freshness: "not_enforced", quantity: null, reason: "vendor sent no 5h bucket in this response" });
    else expect(row, lane).toMatchObject({ freshness: "failed", quantity: null });
  }
  expect(JSON.stringify(rows)).not.toMatch(/placeholder/i);
}

async function localPoll(record: RecordPrincipal, loginState: "logged_in" | "not_logged_in" = "logged_in") {
  const root = await mkdtemp(join(tmpdir(), "headroom-agy-lanes-"));
  temporary.push(root);
  await writeFile(join(root, "accounts.toml"), `[[accounts]]\nname = "${PRINCIPAL}"\nvendor = "antigravity"\nlocation = "agy"\nadapter = "native-ts"\n`, { mode: 0o600 });
  process.env.HEADROOM_HOME = root;
  vi.mocked(nativeEnginePath).mockResolvedValue("/fake/engine");
  vi.mocked(runNativeEngine).mockReset().mockImplementation(async () => engineRowsFromRecord(record, PRINCIPAL, NOW));
  const result = await pollAccounts(undefined, { nativeEngineAvailable: true, daemonOwnsAntigravity: true, antigravityLoginState: loginState });
  const rows = result.observations.filter((row) => row.principal_id === PRINCIPAL);
  const read = result.antigravityLocal?.[PRINCIPAL];
  expect(JSON.stringify(read)).not.toMatch(/placeholder/i);
  return { rows, read };
}

describe("09-29 weekly exhausted (recorded live fixture)", () => {
  const expected: Expected = { "gemini 5h": "blocked_by_weekly", "gemini weekly": "fresh", "claude-gpt 5h": "fresh", "claude-gpt weekly": "fresh" };

  it("classifies the disabled gemini 5h bucket as blocked by the weekly, the read as complete, and the other lanes fresh", async () => {
    const record = await principalFrom("2026-09-29-weekly-exhausted.json");
    const classification = classifyAntigravityLanes(antigravityPayloadFromEngineRows(engineRowsFromRecord(record, PRINCIPAL, NOW), PRINCIPAL).payload);
    expect(statesOf(classification)).toEqual(expected);
    expect(classification.complete).toBe(true);
    expect(classification.payloadKind).toBe("quota_summary");
    const blocked = classification.lanes.find((lane) => lane.state === "blocked_by_weekly");
    expect(blocked).toMatchObject({ reason: "blocked: weekly exhausted until 2026-09-30T20:21:49Z", blockedUntil: "2026-09-30T20:21:49Z", remaining: null });
  });

  it("local path: one fresh read, no retry, no placeholder, no invented number", async () => {
    const record = await principalFrom("2026-09-29-weekly-exhausted.json");
    const { rows, read } = await localPoll(record);
    expect(runNativeEngine).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(4);
    expectLaneRows(rows, expected);
    expect(laneRow(rows, "gemini 5h")).toMatchObject({ reason: "blocked: weekly exhausted until 2026-09-30T20:21:49Z", resets_at: null, metadata: { blocked_until: "2026-09-30T20:21:49Z" } });
    expect(laneRow(rows, "gemini weekly")?.quantity).toMatchObject({ used: 100, remaining: 0 });
    expect(rows.some((row) => "lane" in row)).toBe(false);
    expect(read).toMatchObject({ outcome: "fresh", payload_kind: "quota_summary", lanes: expected });
  });

  it("remote path: the same payload classifies the same way", async () => {
    const record = await principalFrom("2026-09-29-weekly-exhausted.json");
    const rows = observationsFromAntigravityQuota(remoteBodyFromRecord(record), ACCOUNT, new Date(NOW));
    expect(statesOf(classifyAntigravityLanes(antigravityPayloadFromQuota(remoteBodyFromRecord(record))))).toEqual(expected);
    expectLaneRows(rows, expected);
    // The disabled bucket's fraction of 1 was read as 100% remaining before.
    expect(laneRow(rows, "gemini 5h")?.quantity).toBeNull();
  });

  it("status names the block instead of a generic UNKNOWN, the canary accepts it, and gates fail closed for that lane only", async () => {
    const record = await principalFrom("2026-09-29-weekly-exhausted.json");
    const { rows } = await localPoll(record);
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-blocked-"));
    temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      // Hourly polls for seven hours, all answering the same way.
      for (let hour = 0; hour <= 7; hour += 1) {
        const at = new Date(Date.parse(NOW) + hour * 3_600_000).toISOString();
        store.insertPoll(rows.map((row) => ({ ...row, observed_at: at, fetched_at: at })));
      }
      const now = new Date(Date.parse(NOW) + 7 * 3_600_000 + 60_000);
      const gemini5h = store.latestPerWindow(`${PRINCIPAL}:gemini`).find((row) => row.window?.minutes === 300)!;
      expect(gemini5h).toMatchObject({ freshness: "failed", metadata: { lane_state: "blocked_by_weekly" } });

      expect(paceDecision(gemini5h, defaultPolicy, now)).toEqual({ state: "UNKNOWN", reason: "blocked: weekly exhausted until 2026-09-30T20:21:49Z" });
      expect(formatMeters([gemini5h], defaultPolicy, new Map(), new Map(), new Map(), now).join("\n")).toContain("5h blocked until 2026-09-30T20:21:49Z (weekly exhausted)");

      expect(isAcceptedLaneReading(gemini5h)).toBe(true);
      const accounts: Account[] = [ACCOUNT];
      expect(findStaleLanes(store, accounts, 6, now)).toEqual([]);

      expect(freshnessGate(gemini5h, 15, now)).toEqual({ ok: false, reason: "blocked: weekly exhausted until 2026-09-30T20:21:49Z", blocked: true });
      const gate = gateFor(store, [{ window: "5h", points: 1 }], `${PRINCIPAL}:gemini`, 0, false, now);
      expect(gate.allowed).toBe(false);
      expect(gate.unknown).toBeUndefined();
      expect(gate.reason).toContain("5h blocked: weekly exhausted until 2026-09-30T20:21:49Z");
      expect(gateFor(store, [{ window: "5h", points: 1 }], `${PRINCIPAL}:claude-gpt`, 0, false, now).allowed).toBe(true);

      const latest = new Map([[`${PRINCIPAL}:gemini`, store.latestPerWindow(`${PRINCIPAL}:gemini`)]]);
      const can = canConsume([`${PRINCIPAL}:gemini`], latest, defaultPolicy, false, now);
      expect(can).toMatchObject({ allowed: false, state: "FREEZE" });
    } finally { store.close(); }
  });
});

describe("09-03 availability-only reply before login (synthetic)", () => {
  const expected: Expected = { "gemini 5h": "unavailable", "gemini weekly": "unavailable", "claude-gpt 5h": "unavailable", "claude-gpt weekly": "unavailable" };

  it("local path: every lane unavailable, never 0% or 100%, and the fake per-model percent is dropped", async () => {
    const record = await principalFrom("2026-09-03-availability-only.synthetic.json");
    const classification = classifyAntigravityLanes(antigravityPayloadFromEngineRows(engineRowsFromRecord(record, PRINCIPAL, NOW), PRINCIPAL).payload);
    expect(statesOf(classification)).toEqual(expected);
    expect(classification.payloadKind).toBe("availability_only");
    const { rows, read } = await localPoll(record);
    expect(rows).toHaveLength(4);
    expectLaneRows(rows, expected);
    expect(rows.every((row) => row.quantity === null)).toBe(true);
    expect(read).toMatchObject({ outcome: "failed", payload_kind: "availability_only" });
  });

  it("remote path: the same answer is availability only", async () => {
    const record = await principalFrom("2026-09-03-availability-only.synthetic.json");
    const rows = observationsFromAntigravityQuota(remoteBodyFromRecord(record), ACCOUNT, new Date(NOW));
    expectLaneRows(rows, expected);
    expect(rows.every((row) => row.reason === "quota endpoint returned availability only")).toBe(true);
  });
});

describe("09-04/05 remote path refused with HTTP 403 (synthetic)", () => {
  it("every lane is an error that keeps the vendor's own refusal text", async () => {
    const record = await principalFrom("2026-09-04-remote-403.synthetic.json");
    expect(record).toMatchObject({ source: "remote", error: "api_error" });
    const rows = await observeAntigravity(ACCOUNT, {
      now: () => new Date(NOW), credentialPaths: () => ["gemini-oauth"],
      readFile: async () => JSON.stringify({ access_token: "not-a-secret", expiry_date: "2026-09-29T21:20:00Z", project: "stored-project" }),
      fetch: async () => new Response(JSON.stringify({ error: { reasonCode: "PERMISSION_DENIED", message: "The caller does not have permission" } }), { status: 403 }),
    });
    const expected: Expected = { "gemini 5h": "error", "gemini weekly": "error", "claude-gpt 5h": "error", "claude-gpt weekly": "error" };
    expectLaneRows(rows, expected);
    expect(rows.every((row) => row.reason?.startsWith("HTTP 403"))).toBe(true);
    expect(statesOf(classifyAntigravityLanes({ kind: "error", error: rows[0].reason! }))).toEqual(expected);
  });
});

describe("09-22 idle 5h bucket missing, issue #55 (synthetic)", () => {
  const expected: Expected = { "gemini 5h": "missing", "gemini weekly": "fresh", "claude-gpt 5h": "fresh", "claude-gpt weekly": "fresh" };

  it("remote path: the missing 5h is an honest not_enforced gap and the other lanes stay fresh", async () => {
    const record = await principalFrom("2026-09-22-idle-5h-missing.synthetic.json");
    const payload = antigravityPayloadFromQuota(remoteBodyFromRecord(record));
    const classification = classifyAntigravityLanes(payload);
    expect(statesOf(classification)).toEqual(expected);
    expect(classification.complete).toBe(false);
    expectLaneRows(observationsFromAntigravityQuota(remoteBodyFromRecord(record), ACCOUNT, new Date(NOW)), expected);
  });

  it("local path: the same answer reads the same way; the read is partial, not failed", async () => {
    const record = await principalFrom("2026-09-22-idle-5h-missing.synthetic.json");
    const { rows, read } = await localPoll(record);
    expectLaneRows(rows, expected);
    expect(read).toMatchObject({ outcome: "partial", payload_kind: "quota_summary", lanes: expected });
  });
});

describe("09-23 to 09-28 weekly lane still loading (synthetic)", () => {
  const expected: Expected = { "gemini 5h": "fresh", "gemini weekly": "loading", "claude-gpt 5h": "fresh", "claude-gpt weekly": "loading" };

  it("local path: the weekly lanes are loading, the 5h lanes stay fresh, and the read is partial", async () => {
    const record = await principalFrom("2026-09-23-weekly-loading.synthetic.json");
    const classification = classifyAntigravityLanes(antigravityPayloadFromEngineRows(engineRowsFromRecord(record, PRINCIPAL, NOW), PRINCIPAL).payload);
    expect(statesOf(classification)).toEqual(expected);
    const { rows, read } = await localPoll(record);
    expect(runNativeEngine).toHaveBeenCalledTimes(2); // one retry for an incomplete read
    expectLaneRows(rows, expected);
    expect(laneRow(rows, "gemini weekly")?.reason).toBe("quota summary not ready: weekly lane still loading");
    expect(read).toMatchObject({ outcome: "partial", payload_kind: "quota_summary", lanes: expected });
  });

  it("remote path: a weekly bucket the vendor never sent is missing and fails; the 5h lanes stay fresh", async () => {
    const record = await principalFrom("2026-09-23-weekly-loading.synthetic.json");
    const rows = observationsFromAntigravityQuota(remoteBodyFromRecord(record), ACCOUNT, new Date(NOW));
    expectLaneRows(rows, { "gemini 5h": "fresh", "gemini weekly": "missing", "claude-gpt 5h": "fresh", "claude-gpt weekly": "missing" });
  });
});

describe("09-23 to 09-28 whole-meter engine error (synthetic)", () => {
  const expected: Expected = { "gemini 5h": "error", "gemini weekly": "error", "claude-gpt 5h": "error", "claude-gpt weekly": "error" };

  it("keeps the engine's own error text on every lane instead of 'agy logged in; quota summary not ready'", async () => {
    const record = await principalFrom("2026-09-25-whole-meter-error.synthetic.json");
    const classification = classifyAntigravityLanes(antigravityPayloadFromEngineRows(engineRowsFromRecord(record, PRINCIPAL, NOW), PRINCIPAL).payload);
    expect(statesOf(classification)).toEqual(expected);
    const { rows, read } = await localPoll(record, "logged_in");
    expectLaneRows(rows, expected);
    expect(rows.every((row) => row.reason === ENGINE_ERROR_TEXT.timed_out)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("quota summary not ready");
    expect(read).toMatchObject({ outcome: "failed", payload_kind: "error" });
  });

  it("a known logged-out agy adds the fix to the real error text, never replacing it", async () => {
    const record = await principalFrom("2026-09-25-whole-meter-error.synthetic.json");
    const { rows } = await localPoll(record, "not_logged_in");
    expect(rows.every((row) => row.reason === `${ENGINE_ERROR_TEXT.timed_out}; agy not logged in (run: agy)`)).toBe(true);
  });
});

describe("partial read: gemini 5h absent, weekly without usage (review finding)", () => {
  const HOUR = 3_600_000;
  const bucket = (meter: "gemini" | "claude-gpt", minutes: 300 | 10_080, usage: boolean) => ({
    meter, minutes, remaining: usage ? 0.9 : null, usageKnown: usage, disabled: null, resetsAt: usage ? "2026-10-01T00:00:00Z" : null,
  });
  const rowsAt = (hour: number, geminiWeeklyUsage: boolean): Observation[] => {
    const at = new Date(Date.parse(NOW) + hour * HOUR).toISOString();
    const payload = { kind: "quota_summary" as const, buckets: [bucket("gemini", 10_080, geminiWeeklyUsage), bucket("claude-gpt", 300, true), bucket("claude-gpt", 10_080, true)] };
    return antigravityLaneObservations(classifyAntigravityLanes(payload), PRINCIPAL, { now: at, source: "test" });
  };

  const retiredWeeklies = (store: HeadroomStore, meter: string) =>
    store.history(meter, "1970-01-01T00:00:00Z").filter((row) => row.window?.minutes === 10_080 && row.metadata?.retired);

  it("keeps the failed weekly lane, refuses can and gate, and lets the canary see it go stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-partial-"));
    temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      for (let hour = 0; hour <= 7; hour += 1) store.insertPoll(rowsAt(hour, false));
      const now = new Date(Date.parse(NOW) + 7 * HOUR + 60_000);
      const meter = `${PRINCIPAL}:gemini`;
      expect(retiredWeeklies(store, meter)).toEqual([]);

      const can = canConsume([meter], new Map([[meter, store.latestPerWindow(meter)]]), defaultPolicy, false, now);
      expect(can.allowed).toBe(false);
      expect(gateFor(store, [{ window: "5h", points: 1 }], meter, 0, true, now).allowed).toBe(false);
      expect(gateFor(store, [{ window: "wk", points: 1 }], meter, 0, false, now).allowed).toBe(false);

      expect(findStaleLanes(store, [ACCOUNT], 6, now).map((lane) => `${lane.meter}:${lane.window_minutes}`)).toContain(`${meter}:10080`);
    } finally { store.close(); }
  });

  it("only retires a lane the poll never mentioned", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-retire-"));
    temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      const meter = `${PRINCIPAL}:gemini`;
      store.insertPoll(rowsAt(0, true));
      store.insertPoll(rowsAt(2, true).filter((row) => !(row.meter_id === meter && row.window?.minutes === 10_080)));
      expect(retiredWeeklies(store, meter)).toHaveLength(1);
    } finally { store.close(); }
  });
});

describe("weekly resets while the 5h bucket keeps failing (review finding)", () => {
  const HOUR = 3_600_000;
  const meter = `${PRINCIPAL}:gemini`;

  it("shows the newer ordinary failure, not the older blocked row, and keeps the gate unknown", async () => {
    const record = await principalFrom("2026-09-29-weekly-exhausted.json");
    const { rows: blocked } = await localPoll(record);
    const at = new Date(Date.parse(NOW) + HOUR).toISOString();
    // Weekly is back to fresh capacity; the 5h bucket still has no usage.
    const bucket = (name: "gemini" | "claude-gpt", minutes: 300 | 10_080, usage: boolean) => ({
      meter: name, minutes, remaining: usage ? 0.9 : null, usageKnown: usage, disabled: null, resetsAt: usage ? "2026-10-08T00:00:00Z" : null,
    });
    const payload = { kind: "quota_summary" as const, buckets: [bucket("gemini", 300, false), bucket("gemini", 10_080, true), bucket("claude-gpt", 300, true), bucket("claude-gpt", 10_080, true)] };
    const newer = antigravityLaneObservations(classifyAntigravityLanes(payload), PRINCIPAL, { now: at, source: "test" });
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-newer-failure-"));
    temporary.push(root);
    const store = await HeadroomStore.open(join(root, ".headroom"));
    try {
      store.insertPoll(blocked.map((row) => ({ ...row, observed_at: NOW, fetched_at: NOW })));
      store.insertPoll(newer);
      const now = new Date(Date.parse(at) + 60_000);
      const five = store.latestPerWindow(meter).find((row) => row.window?.minutes === 300)!;
      expect(five.freshness).toBe("failed");
      expect(five.metadata?.lane_state).not.toBe("blocked_by_weekly");
      expect(five.fetched_at).toBe(at);
      expect(paceDecision(five, defaultPolicy, now).state).toBe("UNKNOWN");
      expect(paceDecision(five, defaultPolicy, now).reason).not.toContain("weekly exhausted");
      const can = canConsume([meter], new Map([[meter, store.latestPerWindow(meter)]]), defaultPolicy, false, now);
      expect(can.allowed).toBe(false);
      expect(can.state).not.toBe("FREEZE");
      const gate = gateFor(store, [{ window: "5h", points: 1 }], meter, 0, false, now);
      expect(gate).toMatchObject({ allowed: false, unknown: true });
    } finally { store.close(); }
  });
});
