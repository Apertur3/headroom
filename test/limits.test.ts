import { describe, expect, it } from "vitest";
import { assertVendorResponseLimits, vendorJson } from "../src/limits.js";

describe("vendor response limits", () => {
  it("rejects oversized strings, arrays, and deeply nested JSON", async () => {
    expect(() => assertVendorResponseLimits("x".repeat(65_537))).toThrow("oversized");
    expect(() => assertVendorResponseLimits(Array(10_001).fill(0))).toThrow("too many");
    let deep: unknown = 0; for (let i = 0; i < 33; i += 1) deep = { deep };
    expect(() => assertVendorResponseLimits(deep)).toThrow("depth");
    await expect(vendorJson(new Response("x".repeat(1_048_577)))).rejects.toThrow("1 MiB");
  });
});
