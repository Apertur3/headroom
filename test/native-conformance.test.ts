import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { adaptCodexPayload } from "../src/engine/codexbar/adapt.js";
import { IDLE_WINDOW_REASON, detectPlaceholder, normalizeObservations, observationsFromReading } from "../src/engine/observation.js";
import { parseObservations } from "../src/engine/native/run.js";

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

  it("flags the synthesized-reset idle window with a doubt marker but accepts a real capture as-is", async () => {
    const placeholderText = await readFile(new URL("../fixtures/native/v0.56.4/antigravity-placeholder.json", import.meta.url), "utf8");
    const realText = await readFile(new URL("../fixtures/native/v0.56.4/codex-antigravity.json", import.meta.url), "utf8");
    const rawPlaceholder = JSON.parse(placeholderText);
    expect(detectPlaceholder(rawPlaceholder)).toBe(true);
    // The vendor's own numbers stay: freshness and quantity are untouched, only
    // truth and confidence move to flag the doubt (the 2026-09 vendor-numbers
    // decision -- Headroom shows what Google reports instead of UNKNOWN).
    expect(parseObservations(placeholderText)).toEqual(expect.arrayContaining([
      expect.objectContaining({ meter_id: "antigravity:gemini", freshness: "fresh", truth: "estimated", confidence: 0.5, reason: IDLE_WINDOW_REASON, quantity: expect.objectContaining({ used: 0 }) }),
    ]));
    expect(detectPlaceholder(JSON.parse(realText))).toBe(false);
    expect(parseObservations(realText).filter((item) => item.principal_id === "antigravity")).toEqual(expect.arrayContaining([
      expect.objectContaining({ freshness: "fresh", truth: "official" }),
    ]));
  });

  it("does not reject one zero window or a real zero reading with a non-synthetic reset", async () => {
    const placeholder = JSON.parse(await readFile(new URL("../fixtures/native/v0.56.4/antigravity-placeholder.json", import.meta.url), "utf8"));
    expect(detectPlaceholder([placeholder[0]])).toBe(false);
    const nonSynthetic = structuredClone(placeholder);
    nonSynthetic[1].resets_at = "2026-09-08T19:38:37Z";
    expect(detectPlaceholder(nonSynthetic)).toBe(false);
  });

  it("does not alter local or not-enforced observations in a flagged snapshot", async () => {
    const placeholder = JSON.parse(await readFile(new URL("../fixtures/native/v0.56.4/antigravity-placeholder.json", import.meta.url), "utf8"));
    const absent = { ...placeholder[0], meter_id: "antigravity:claude-gpt", freshness: "not_enforced", quantity: null, resets_at: null };
    const local = { ...placeholder[0], principal_id: "gpu-box", meter_id: "gpu-box:capacity", source: "native:local", window: { kind: "state", minutes: null, enforcement: "soft" }, resets_at: null };
    const normalized = normalizeObservations([...placeholder, absent, local]);
    expect(normalized.find((item) => item.meter_id === "antigravity:claude-gpt")).toMatchObject({ freshness: "not_enforced" });
    expect(normalized.find((item) => item.meter_id === "gpu-box:capacity")).toMatchObject({ freshness: "fresh", truth: "official" });
  });
});
