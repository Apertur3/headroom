import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { socketPath, HeadroomDaemon } from "../src/daemon.js";
import type { Observation } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function fixture(): Observation {
  return {
    principal_id: "codex-main", meter_id: "codex-main:main", window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" }, resets_at: "2026-09-03T13:00:00Z",
    observed_at: "2026-09-03T12:00:00Z", fetched_at: "2026-09-03T12:00:00Z", source: "fixture", truth: "official",
    freshness: "fresh", confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

describe("headroom --refresh / --ttl 0", () => {
  // See test/daemon-mcp.test.ts's own "plan/gate/fill round-trip" test for
  // why the daemon under test listens on the real socketPath() on Windows: a
  // named pipe is not HEADROOM_HOME-scoped the way the POSIX socket path is,
  // and main()'s own daemon client always dials the real one.
  it("--refresh forces a fresh poll once the poll interval has elapsed, and is a safe no-op (rate_limited, not a vendor hit) within it", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-refresh-cli-")); temporary.push(root);
    // 3s: the "within interval" assertions below need three real main()
    // round-trips (daemon.start() plus three socket calls) to land inside
    // this window before it elapses. A ~500ms window left almost no margin
    // for that -- on a loaded Windows CI runner the combined overhead of
    // those calls could itself exceed 500ms, so the interval had already
    // elapsed by the third call, and the "still throttled" assertion saw an
    // extra real poll it didn't expect.
    await writeFile(join(root, "policy.toml"), "poll_interval_minutes = 0.05\n"); // 3s
    let polls = 0;
    const path = socketPath(root);
    const daemon = await HeadroomDaemon.create({ home: root, path, poller: async () => { polls += 1; return { observations: [fixture()], failures: [] }; } });
    try { await daemon.start(); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { await daemon.stop(); expect((error as NodeJS.ErrnoException).code).toBe("EPERM"); return; }
      throw error;
    }
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      // First call: nothing polled yet, always goes through regardless of --refresh.
      expect(await main(["--json"])).toBe(0);
      expect(polls).toBe(1);

      // Immediately after: a plain status call must not poll again (cached).
      expect(await main(["--json"])).toBe(0);
      expect(polls).toBe(1);

      // --refresh within the same (tiny but nonzero) interval is throttled the
      // same safe way: no extra vendor hit, but a note on stderr says so.
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(await main(["--refresh", "--json"])).toBe(0);
      } finally { stderrSpy.mockRestore(); }
      expect(polls).toBe(1);

      // Once the interval has actually elapsed, --refresh (and its --ttl 0
      // synonym) really does force a fresh poll.
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      expect(await main(["--refresh", "--json"])).toBe(0);
      expect(polls).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      expect(await main(["--json", "--ttl", "0"])).toBe(0);
      expect(polls).toBe(3);
    } finally {
      if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous;
      await daemon.stop();
    }
  }, 20_000); // two deliberate 3.5s waits blow past the default 5s per-test timeout

  it("--refresh accepts --principal and is a harmless no-op with no daemon running (a direct read always polls fresh)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-refresh-nodaemon-")); temporary.push(root);
    await writeFile(join(root, "accounts.toml"), "");
    const previous = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    try {
      expect(await main(["--refresh", "--principal", "codex-main", "--json"])).toBe(0);
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });
});
