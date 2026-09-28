import { describe, expect, it, vi } from "vitest";
import type { Observation } from "../src/types.js";

const observeClaude = vi.fn(async (): Promise<Observation[]> => []);
const observeCodex = vi.fn(async (account: { name: string }): Promise<Observation[]> => [{
  principal_id: account.name, meter_id: `${account.name}:main`, window: null,
  quantity: null, resets_at: null, observed_at: "2026-09-08T00:00:00Z", fetched_at: "2026-09-08T00:00:00Z",
  source: "fixture", truth: "official", freshness: "failed", confidence: 0, adapter_version: "fixture", upstream_schema_version: "fixture",
}]);

vi.mock("../src/registry.js", () => ({ readAccounts: vi.fn(async () => [
  { name: "claude-2", enabled: false, vendor: "claude", location: "/fixture/.claude2", adapter: "native-ts" },
  { name: "codex-main", vendor: "codex", location: "/fixture/.codex", adapter: "native-ts" },
]) }));
vi.mock("../src/adapters/claude.js", () => ({
  observeClaude, claudeGrantNeededObservations: vi.fn(() => []), isClaudeProbeDenialReason: vi.fn(() => false),
}));
vi.mock("../src/adapters/codex.js", () => ({ observeCodex, codexResponseShape: vi.fn() }));

describe("collector disabled principal boundary", () => {
  it("does not invoke a disabled Claude probe while it continues reading an enabled sibling", async () => {
    const { pollAccounts } = await import("../src/collector.js");
    const result = await pollAccounts();
    expect(observeClaude).not.toHaveBeenCalled();
    expect(observeCodex).toHaveBeenCalledWith(expect.objectContaining({ name: "codex-main" }));
    expect(result.observations).toEqual([expect.objectContaining({ principal_id: "codex-main" })]);
    expect(result.observations).not.toEqual(expect.arrayContaining([expect.objectContaining({ principal_id: "claude-2" })]));
  });
});
