/**
 * #137: the Windows named pipe name is a digest only, with no part of the
 * username in it. Clients dial the current name and fall back to the legacy
 * `headroom-<username>-<digest>` name, so a daemon an older version started is
 * still found after an upgrade; the daemon itself listens on the current name only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonRequest, HeadroomDaemon, legacyPipeFallback, legacyWindowsPipeName, socketPath } from "../src/daemon.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  // maxRetries: Windows can hold a just-closed pipe's handles for a moment (see pipe-auth.test.ts).
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("Windows pipe name: digest only", () => {
  const home = "C:\\Users\\Alice\\AppData\\Local\\headroom";

  it("carries no part of the username", () => {
    const path = socketPath(home, "win32", "alice-ops");
    expect(path).toMatch(/^\\\\\.\\pipe\\headroom-[0-9a-f]{16}$/);
    expect(path.toLowerCase()).not.toContain("alice");
  });

  it("is stable per user and per home, and differs across users and homes", () => {
    expect(socketPath(home, "win32", "alice")).toBe(socketPath(home, "win32", "alice"));
    expect(socketPath(home, "win32", "alice")).toBe(socketPath(home, "win32", "ALICE"));
    expect(socketPath(home, "win32", "alice")).not.toBe(socketPath(home, "win32", "bob"));
    expect(socketPath(home, "win32", "alice")).not.toBe(socketPath(`${home}-2`, "win32", "alice"));
  });

  it("maps the current name to the legacy name for the same user and home, on Windows only", () => {
    const path = socketPath(home, "win32", "alice");
    const legacy = legacyWindowsPipeName(home, "alice");
    expect(legacy).toMatch(/^\\\\\.\\pipe\\headroom-alice-[0-9a-f]{8}$/);
    expect(legacyPipeFallback(path, "win32")).toBe(legacy);
    expect(legacyPipeFallback(path, "linux")).toBeUndefined();
    expect(legacyPipeFallback("\\\\.\\pipe\\something-else", "win32")).toBeUndefined();
  });

  it("keeps the legacy name exactly as 0.2.6 derived it", () => {
    // Same home spelled two ways: the legacy digest, like the current one, is of the canonical home.
    expect(legacyWindowsPipeName("c:\\users\\alice\\appdata\\local\\headroom\\", "alice")).toBe(legacyWindowsPipeName(home, "alice"));
  });
});

// A real named pipe: only a Windows runner can bind one.
describe.runIf(process.platform === "win32")("Windows pipe name: legacy daemon fallback over a real pipe", () => {
  it("finds a daemon listening on the legacy name, and a new daemon refuses to start beside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hr-legacy-pipe-")); temporary.push(root);
    vi.stubEnv("HEADROOM_HOME", root);
    const legacy = legacyWindowsPipeName(root);
    const poller = async () => ({ observations: [], failures: [] });
    const old = await HeadroomDaemon.create({ home: root, path: legacy, poller });
    try { await old.start(); }
    catch (error: unknown) { await old.stop(); throw error; }
    try {
      await expect(daemonRequest(socketPath(root), "health")).resolves.toMatchObject({ status: "available", result: { socket: legacy } });
      const fresh = await HeadroomDaemon.create({ home: root, path: socketPath(root), poller });
      try { await expect(fresh.start()).rejects.toThrow(/already running/); }
      finally { await fresh.stop(); }
    } finally { await old.stop(); }
  }, 20_000);
});
