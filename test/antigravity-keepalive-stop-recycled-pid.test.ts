import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyKeepaliveSupervisor, keepaliveLaunchStateFilePath } from "../src/antigravity-keepalive.js";
import type { ExecFile } from "../src/process-tree.js";
import { alive, track, useProcessReaper, writeMortalShim } from "./helpers/mortal-process.js";

const temporary: string[] = [];
useProcessReaper();
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** A process table in which every pid now belongs to an unrelated program that started long ago. */
const recycledTable: ExecFile = (async (_file: string, args: string[]) => {
  const keyword = args[1];
  if (keyword === "comm=") return { stdout: "/usr/bin/unrelated\n", stderr: "" };
  if (keyword === "lstart=") return { stdout: "Mon Jan  1 00:00:00 2001\n", stderr: "" };
  if (keyword === "ppid=,pgid=") return { stdout: "1 1\n", stderr: "" };
  return { stdout: "", stderr: "" };
}) as unknown as ExecFile;

describe.skipIf(process.platform === "win32")("AgyKeepaliveSupervisor.stop(): a recycled pid is never signalled", () => {
  it("leaves a pid alone when its live command and start time no longer match the launch evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-stop-recycled-")); temporary.push(root);
    const logs: string[] = [];
    // The launch wrapper is a plain mortal shim, so only stop()'s own signal to
    // the recorded pid can end it.
    const shim = await writeMortalShim(join(root, "wrapper"));
    const supervisor = new AgyKeepaliveSupervisor({
      binary: shim, home: root, pidDiscoveryAttempts: 1, pidDiscoveryIntervalMs: 20,
      killGraceMs: 100, restartDelay: () => 30_000, execImpl: recycledTable, log: (message) => logs.push(message),
      spawn: (() => spawn(shim, [], { stdio: "ignore" })) as never,
    });
    supervisor.start();
    const scriptPid = track(supervisor.pid, root) as number;
    await vi.waitFor(async () => {
      const state = JSON.parse(await readFile(keepaliveLaunchStateFilePath(root, supervisor.launchId as string), "utf8")) as { verified?: boolean };
      expect(state.verified).toBe(true);
    }, { timeout: 5_000, interval: 20 });

    await supervisor.stop();

    // From the evidence's point of view, scriptPid is someone else's process now.
    expect(alive(scriptPid)).toBe(true);
    expect(logs.join("\n")).toContain(`pid ${scriptPid} no longer matches`);
  });
});
