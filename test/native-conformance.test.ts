import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { adaptCodexPayload } from "../src/engine/codexbar/adapt.js";
import { observationsFromReading } from "../src/engine/observation.js";

describe("native/fallback Codex conformance", () => {
  it("uses the same Codex meter IDs and percent units", async () => {
    const payload = JSON.parse(await readFile(new URL("../fixtures/codexbar/v0.56.4/codex.json", import.meta.url), "utf8"));
    const fallback = adaptCodexPayload(payload, "codex-main", "2026-09-03T13:24:00Z").flatMap(observationsFromReading);
    const fixture = JSON.parse(await readFile(new URL("../fixtures/native/v0.56.4/placeholder.json", import.meta.url), "utf8"));
    const native = fixture.observations;
    expect(new Set(native.map((item: { meter_id: string }) => item.meter_id))).toEqual(new Set(fallback.map((item) => item.meter_id)));
    expect(native[0]).toMatchObject({ meter_id: "codex-main:main", quantity: { unit: "percent" } });
    expect(fallback.every((item) => item.quantity?.unit === "percent")).toBe(true);
  });
});
