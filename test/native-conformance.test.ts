import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { adaptCodexPayload } from "../src/engine/codexbar/adapt.js";
import { observationsFromReading } from "../src/engine/observation.js";

describe("native engine conformance", () => {
  it("uses the redacted live Codex/Antigravity capture and stable percent units", async () => {
    const payload = JSON.parse(await readFile(new URL("../fixtures/codexbar/v0.56.4/codex.json", import.meta.url), "utf8"));
    const fallback = adaptCodexPayload(payload, "codex-main", "2026-09-03T13:24:00Z").flatMap(observationsFromReading);
    const native = JSON.parse(await readFile(new URL("../fixtures/native/v0.56.4/codex-antigravity.json", import.meta.url), "utf8"));
    expect(native).toEqual(expect.arrayContaining([
      expect.objectContaining({ meter_id: "codex-main:main", quantity: expect.objectContaining({ unit: "percent" }), truth: "official", freshness: "fresh" }),
      expect.objectContaining({ meter_id: "antigravity:gemini", quantity: expect.objectContaining({ unit: "percent" }), truth: "official", freshness: "fresh" }),
      expect.objectContaining({ meter_id: "antigravity:claude-gpt", quantity: expect.objectContaining({ unit: "percent" }), truth: "official", freshness: "fresh" }),
    ]));
    expect(fallback.some((item) => item.meter_id === "codex-main:main")).toBe(true);
    expect(fallback.every((item) => item.quantity?.unit === "percent")).toBe(true);
  });
});
