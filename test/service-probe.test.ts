import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const daemonRequest = vi.hoisted(() => vi.fn(async () => ({ status: "available" as const, result: {} })));
vi.mock("../src/daemon.js", () => ({ daemonRequest, socketPath: () => "/tmp/headroom-probe-test.sock" }));

import { installAndStartService } from "../src/service.js";

describe("service start health probe", () => {
  it("bounds both RPCs of the daemon health check, not just the first", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-service-probe-"));
    try {
      const runner = async () => ({ code: 0, output: "" });
      await installAndStartService("/usr/local/bin/headroom", "darwin", home, "/usr/local/bin/node", { ...process.env, HEADROOM_HOME: join(home, ".headroom") }, "tester", { runner, sleep: async () => undefined, intervalMs: 1, waitMs: 1, uid: 501 });
    } finally { await rm(home, { recursive: true, force: true }); }
    expect(daemonRequest).toHaveBeenCalled();
    const [, method, , healthTimeout, requestTimeout] = daemonRequest.mock.calls[0] as unknown as [string, string, unknown, number, number];
    expect(method).toBe("health");
    expect(healthTimeout).toBe(500);
    expect(requestTimeout).toBe(500);
  });
});
