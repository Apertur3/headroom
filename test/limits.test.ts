import { describe, expect, it } from "vitest";
import { assertVendorResponseLimits, vendorJson, vendorText } from "../src/limits.js";

describe("vendor response limits", () => {
  it("rejects oversized strings, arrays, and deeply nested JSON", async () => {
    expect(() => assertVendorResponseLimits("x".repeat(65_537))).toThrow("oversized");
    expect(() => assertVendorResponseLimits(Array(10_001).fill(0))).toThrow("too many");
    let deep: unknown = 0; for (let i = 0; i < 33; i += 1) deep = { deep };
    expect(() => assertVendorResponseLimits(deep)).toThrow("depth");
    await expect(vendorJson(new Response("x".repeat(1_048_577)))).rejects.toThrow("1 MiB");
  });

  it("aborts a streamed response once the byte cap is exceeded, instead of buffering the whole body first", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunkBytes = 256 * 1024; // 256 KiB chunks
    const totalChunks = 10; // 2.5 MiB total, well over the 1 MiB cap
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cancelled || pulled >= totalChunks) { controller.close(); return; }
        pulled += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() { cancelled = true; },
    });
    const response = new Response(stream);
    await expect(vendorText(response)).rejects.toThrow("1 MiB");
    // Only enough chunks to cross the cap (5 x 256 KiB = 1.25 MiB) should
    // have been pulled, not all 10 (2.5 MiB): the stream is cancelled mid-way.
    expect(pulled).toBeLessThan(totalChunks);
    expect(cancelled).toBe(true);
  });
});
