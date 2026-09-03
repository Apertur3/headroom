import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { adaptCodexPayload } from "../src/engine/codexbar/adapt.js";
import { observationsFromReading } from "../src/engine/observation.js";

describe("CodexBar Codex adapter", () => {
  it("adapts the pinned redacted Codex fixture into main and spark pools", async () => {
    const payload = JSON.parse(await readFile(new URL("../fixtures/codexbar/v0.56.4/codex.json", import.meta.url), "utf8"));
    const readings = adaptCodexPayload(payload, "codex-main", "2026-09-03T13:24:00Z");
    expect(readings).toHaveLength(2);
    expect(readings[0]).toMatchObject({
      account: "codex-main", pool: "main", plan: "pro", truth: "official",
      windows: { five_hour: { used_percent: 12, window_minutes: 300 }, weekly: { used_percent: 3, window_minutes: 10080 } },
      extras: { free_resets_available: 1, credits: [{ status: "available", expires_at: "2026-09-08T17:23:00Z" }] },
    });
    expect(readings[1]).toMatchObject({
      pool: "spark",
      windows: { five_hour: { used_percent: 8 }, weekly: { used_percent: 2 } },
    });
  });

  it("records unknown field names without retaining their values", () => {
    const readings = adaptCodexPayload({ provider: "codex", source: "cli", usage: { loginMethod: "pro", primary: { usedPercent: 1 }, unexpectedField: "not-retained" } }, "codex-main");
    expect(readings[0].truth).toBe("estimated");
    expect(readings[0].extras.unmapped).toContain("usage.unexpectedField");
    expect(JSON.stringify(readings)).not.toContain("not-retained");
  });

  it("keeps an upstream-null 5-hour Codex cap as a non-enforced window", () => {
    const readings = adaptCodexPayload({ provider: "codex", source: "oauth", usage: { loginMethod: "pro", primary: null, secondary: { usedPercent: 3, resetsAt: "2026-09-10T15:08:00Z", windowMinutes: 10080 } } }, "codex-main", "2026-09-03T13:24:00Z");
    expect(observationsFromReading(readings[0])).toContainEqual(expect.objectContaining({ meter_id: "codex-main:main", freshness: "not_enforced", window: { kind: "rolling", minutes: 300, enforcement: "hard" }, reason: "vendor returned no 5-hour window" }));
  });
});
