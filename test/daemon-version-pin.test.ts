/**
 * A daemon reports the version it started as, not whatever package.json says later: an in-place
 * `npm i -g` replaces package.json under a running daemon, and install-service must still see the
 * running code as the old version and restart it, even when the pipe name did not change.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// What package.json says right now; the test "upgrades" it after the daemon started.
const onDisk = vi.hoisted(() => ({ version: "1.0.0" }));
vi.mock("../src/version.js", () => ({ headroomVersion: async () => onDisk.version }));

const { HeadroomDaemon } = await import("../src/daemon.js");
const { installAndStartService, serviceContents, servicePath } = await import("../src/service.js");
const { authedHandleLine } = await import("./helpers/daemon-rpc.js");

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))); });

function testSocketPath(root: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}-pin` : join(root, "headroom.sock");
}

describe("daemon version pinned at start", () => {
  it("health keeps the started version after package.json changes, and install-service then restarts it", async () => {
    onDisk.version = "1.0.0";
    const root = await mkdtemp(join(tmpdir(), "headroom-version-pin-")); temporary.push(root);
    const socket = testSocketPath(root);
    const daemon = await HeadroomDaemon.create({ home: root, path: socket, poller: async () => ({ observations: [], failures: [] }) });
    let health: { version?: string; socket?: string } | undefined;
    try {
      await daemon.start();
      onDisk.version = "2.0.0"; // npm replaced package.json; the daemon never answered health before
      health = (await authedHandleLine(daemon, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health", params: {} }))).result as typeof health;
    } finally { await daemon.stop(); }
    expect(health).toMatchObject({ version: "1.0.0", socket });

    // install-service with the upgraded CLI: same definition, same pipe, task Running, daemon answering.
    const home = await mkdtemp(join(tmpdir(), "headroom-version-pin-service-")); temporary.push(home);
    const env = { ...process.env, HEADROOM_HOME: join(home, ".headroom") };
    const path = servicePath("win32", home, env); temporary.push(path); // backslash-joined on posix: a stray file in the cwd
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serviceContents("/usr/local/bin/headroom", "win32", "/usr/local/bin/node", "tester", home, env));
    let running: { version?: string; socket?: string } | undefined = health;
    const calls: string[] = [];
    const requestShutdown = vi.fn(async () => { running = undefined; return "accepted" as const; });
    const result = await installAndStartService("/usr/local/bin/headroom", "win32", home, "/usr/local/bin/node", env, "tester", {
      sleep: async () => undefined, intervalMs: 1, waitMs: 3, stopWaitMs: 5, uid: 501,
      runner: async (command, args) => {
        if (command === "powershell") return { code: 0, output: "Running" };
        calls.push(args[0]);
        if (args[0] === "/Run") running = { version: onDisk.version, socket };
        return { code: 0, output: "" };
      },
      probe: async () => running !== undefined,
      identify: async () => running,
      expected: { version: onDisk.version, socket },
      requestShutdown,
    });
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ state: "restarted", reason: "the running daemon is version 1.0.0, this is 2.0.0" });
    expect(calls).toEqual(["/End", "/Run"]);
  });
});
