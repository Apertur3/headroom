import { EventEmitter } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgyKeepaliveSupervisor } from "../src/antigravity-keepalive.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("ends its agy after agy updates itself, so the exit path relaunches the new binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "headroom-agy-update-")); temporary.push(root);
  const binary = join(root, "agy");
  await writeFile(binary, "old", { mode: 0o700 });
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, kill: vi.fn(() => true) });
  const supervisor = new AgyKeepaliveSupervisor({ binary, platform: "darwin", spawn: vi.fn(() => child) as never });
  try {
    supervisor.start();
    expect(supervisor.restartIfBinaryReplaced()).toBe(false);
    // agy's updater renames the running file away and writes the new version in its place.
    await rename(binary, `${binary}.123.old`);
    await writeFile(binary, "new", { mode: 0o700 });
    expect(supervisor.restartIfBinaryReplaced()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.restartIfBinaryReplaced()).toBe(false); // once per launch
  } finally { void supervisor.stop(); }
});
