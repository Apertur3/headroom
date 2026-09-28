import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alive, track, useProcessReaper, writeFakeAgy } from "./helpers/mortal-process.js";

/**
 * Isolated from antigravity-keepalive-sweep.test.ts on purpose: this file
 * mocks process-tree.js's isProcessGroupAlive to make it always report "still
 * alive", which is otherwise indistinguishable from a real hang -- real
 * SIGKILL cannot be blocked or ignored, so there is no way to make a genuine
 * process fail to disappear within stop()'s confirm window using only real
 * processes and real signals. The mock affects only the CONFIRMATION check;
 * the actual kill signals stop() sends are untouched and real, so the agy
 * this test starts genuinely dies -- the point is proving stop() does not
 * *trust* that it died without independently confirming it, using a real,
 * P0-compliant process (tracked via mortal-process.ts) throughout.
 */
vi.mock("../src/process-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process-tree.js")>();
  return { ...actual, isProcessGroupAlive: () => true };
});

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      const text = await readFile(path, "utf8");
      if (text.trim()) return text.trim();
    } catch { /* not written yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(process.platform === "win32")("AgyKeepaliveSupervisor.stop(): review round 2 (3) -- confirm before clearing evidence", () => {
  it("does not clear the recorded state when the confirmation check keeps reporting the target alive after signalling", async () => {
    const { AgyKeepaliveSupervisor, keepaliveStateFilePath } = await import("../src/antigravity-keepalive.js");
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stop-unconfirmed-")); temporary.push(root);
    const infoFile = join(root, "agy-pid.txt");
    const fakeAgy = await writeFakeAgy(root, infoFile);
    const supervisor = new AgyKeepaliveSupervisor({
      binary: fakeAgy, home: root, pidDiscoveryIntervalMs: 20, pidDiscoveryAttempts: 100, killGraceMs: 100,
    });
    supervisor.start();
    const agyPid = track(Number(await waitForFile(infoFile)), root) as number;
    track(supervisor.pid, root);

    await supervisor.stop();

    // The real kill signals were sent for real and agy really did exit --
    // isProcessGroupAlive is only mocked, the actual process is not immune
    // to SIGKILL -- but stop() was told (via the mock) that it could never
    // confirm that, so it must not have discarded the evidence.
    expect(alive(agyPid)).toBe(false);
    await expect(readFile(keepaliveStateFilePath(root), "utf8")).resolves.toBeTruthy();
  }, 15_000);
});
