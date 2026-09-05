import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProbePath } from "../src/adapters/claude.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withoutProbeOverride<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_PROBE_PATH;
  delete process.env.HEADROOM_PROBE_PATH;
  try { return await run(); }
  finally { if (previous !== undefined) process.env.HEADROOM_PROBE_PATH = previous; }
}

describe("resolveProbePath: a pinned probe path wins over the normal resolution order", () => {
  it("returns the pinned binary directly when it still resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-pin-")); temporary.push(root);
    const pinned = join(root, "pinned-probe");
    await writeFile(pinned, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(pinned, 0o755);
    // resolveProbePath() realpath()s its result (macOS's /var -> /private/var
    // system alias, most commonly); compare against the same canonicalized
    // form rather than the raw mkdtemp path.
    const canonical = await realpath(pinned);
    await withoutProbeOverride(async () => {
      await expect(resolveProbePath(pinned)).resolves.toBe(canonical);
    });
  });

  it("falls through (never throws) when the pinned path no longer exists", async () => {
    await withoutProbeOverride(async () => {
      // Neither a packaged nor a repo dev-build probe exists in this test
      // checkout's build output by default, so a gone pin falling through
      // resolves to undefined here -- proof it fell through to the normal
      // order rather than insisting on the missing pin.
      await expect(resolveProbePath("/nonexistent/gone-probe")).resolves.not.toBe("/nonexistent/gone-probe");
    });
  });

  it("HEADROOM_PROBE_PATH (an explicit development override) still wins over a pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-pin-override-")); temporary.push(root);
    const pinned = join(root, "pinned-probe");
    const overridden = join(root, "override-probe");
    for (const path of [pinned, overridden]) { await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); await chmod(path, 0o755); }
    const canonicalOverride = await realpath(overridden);
    const previous = process.env.HEADROOM_PROBE_PATH;
    process.env.HEADROOM_PROBE_PATH = overridden;
    try {
      await expect(resolveProbePath(pinned)).resolves.toBe(canonicalOverride);
    } finally { if (previous === undefined) delete process.env.HEADROOM_PROBE_PATH; else process.env.HEADROOM_PROBE_PATH = previous; }
  });
});
