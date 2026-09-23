import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pollAccounts } from "../src/collector.js";
import { nativeEnginePath, runNativeEngine } from "../src/engine/native/run.js";
import type { Observation } from "../src/types.js";

vi.mock("../src/engine/native/run.js", () => ({ nativeEnginePath: vi.fn(), runNativeEngine: vi.fn() }));
let root = "";
const previousHome = process.env.HEADROOM_HOME;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

it("keeps every Antigravity window UNKNOWN when its reader is missing, even during remote backoff", async () => {
  root = await mkdtemp(join(tmpdir(), "headroom-agy-local-"));
  await writeFile(join(root, "accounts.toml"), '[[accounts]]\nname = "antigravity"\nvendor = "antigravity"\nlocation = "agy"\nadapter = "native-ts"\n', { mode: 0o600 });
  process.env.HEADROOM_HOME = root;
  vi.mocked(nativeEnginePath).mockResolvedValue(undefined);
  const network = vi.spyOn(globalThis, "fetch");
  for (const skipRemoteAntigravity of [false, true]) {
    const result = await pollAccounts(undefined, { daemonOwnsAntigravity: true, skipRemoteAntigravity, antigravityLoginState: "logged_in" });
    expect(result.observations).toHaveLength(4);
    expect(result.observations.every((row) => row.freshness === "failed" && row.quantity === null)).toBe(true);
    expect(result.observations[0].reason).toContain(process.platform !== "darwin" ? "not available on this platform" : "native reader missing");
    expect(result.antigravityLocal?.antigravity.outcome).toBe("failed");
  }
  expect(network).not.toHaveBeenCalled();
  expect(runNativeEngine).not.toHaveBeenCalled();
});

function freshRow(meter: "gemini" | "claude-gpt", minutes: 300 | 10_080): Observation {
  return {
    principal_id: "antigravity", meter_id: `antigravity:${meter}`, window: { kind: minutes === 300 ? "rolling" : "fixed", minutes, enforcement: "hard" },
    quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" }, resets_at: "2026-09-10T00:00:00Z",
    observed_at: "2026-09-03T00:00:00Z", fetched_at: "2026-09-03T00:00:00Z", source: "local:antigravity:warm",
    truth: "official", freshness: "fresh", confidence: 1, adapter_version: "test", upstream_schema_version: "test",
  };
}

const COMPLETE_ANTIGRAVITY_ROWS: Observation[] = (["gemini", "claude-gpt"] as const)
  .flatMap((meter) => ([300, 10_080] as const).map((minutes) => freshRow(meter, minutes)));

/** Mirrors the Swift engine's catch-all `failed()` shape (see
 * HeadroomEngine.swift's `observe()`): a whole-meter, windowless failure pair
 * for both Antigravity meters -- the "placeholder" outcome collector.ts
 * classifies when the native engine returned something, but not a complete
 * warm summary. This is what agy's local server produces while its quota
 * summary is still warming or the machine is briefly busy. */
function transientFailurePair(): Observation[] {
  return (["gemini", "claude-gpt"] as const).map((meter) => ({
    principal_id: "antigravity", meter_id: `antigravity:${meter}`, window: null, quantity: null, resets_at: null,
    observed_at: "2026-09-03T00:00:00Z", fetched_at: "2026-09-03T00:00:00Z", source: "engine:native",
    truth: "estimated" as const, freshness: "failed" as const, confidence: 0, adapter_version: "test", upstream_schema_version: "test",
    reason: "agy transient",
  }));
}

it("retries the native Antigravity read once within the same poll and uses a complete retry", async () => {
  root = await mkdtemp(join(tmpdir(), "headroom-agy-retry-"));
  await writeFile(join(root, "accounts.toml"), '[[accounts]]\nname = "antigravity"\nvendor = "antigravity"\nlocation = "agy"\nadapter = "native-ts"\n', { mode: 0o600 });
  process.env.HEADROOM_HOME = root;
  vi.mocked(nativeEnginePath).mockResolvedValue("/fake/engine");
  vi.mocked(runNativeEngine).mockReset().mockResolvedValueOnce(transientFailurePair()).mockResolvedValueOnce(COMPLETE_ANTIGRAVITY_ROWS);
  const result = await pollAccounts(undefined, { daemonOwnsAntigravity: true, antigravityLoginState: "logged_in" });
  expect(runNativeEngine).toHaveBeenCalledTimes(2);
  const rows = result.observations.filter((item) => item.principal_id === "antigravity");
  expect(rows).toHaveLength(4);
  expect(rows.every((item) => item.freshness === "fresh")).toBe(true);
  expect(result.antigravityLocal?.antigravity).toMatchObject({ outcome: "fresh", payload_kind: "quota_summary" });
});

it("gives up after one retry and reports the transient failure honestly when it persists", async () => {
  root = await mkdtemp(join(tmpdir(), "headroom-agy-retry-persist-"));
  await writeFile(join(root, "accounts.toml"), '[[accounts]]\nname = "antigravity"\nvendor = "antigravity"\nlocation = "agy"\nadapter = "native-ts"\n', { mode: 0o600 });
  process.env.HEADROOM_HOME = root;
  vi.mocked(nativeEnginePath).mockResolvedValue("/fake/engine");
  vi.mocked(runNativeEngine).mockReset().mockResolvedValue(transientFailurePair()); // still incomplete every call
  const result = await pollAccounts(undefined, { daemonOwnsAntigravity: true, antigravityLoginState: "logged_in" });
  expect(runNativeEngine).toHaveBeenCalledTimes(2); // one retry, not an unbounded loop
  const rows = result.observations.filter((item) => item.principal_id === "antigravity");
  expect(rows).toHaveLength(2);
  expect(rows.every((item) => item.freshness === "failed")).toBe(true);
  expect(result.antigravityLocal?.antigravity.payload_kind).toBe("placeholder");
});
