import { vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostGuardPolicy, HostHealthDeps } from "../src/host-health.js";

// Every test worker starts with HOME and HEADROOM_HOME pointing at fresh
// temporary directories, so no test can read or write the developer's real
// Headroom home, Claude profiles or credential files even when it forgets to
// scope them itself. A test that needs a specific home sets it explicitly.
const isolatedHome = mkdtempSync(join(tmpdir(), "headroom-test-home-"));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.HEADROOM_HOME = join(isolatedHome, ".headroom");
delete process.env.CLAUDE_CONFIG_DIR;

// Rendered clocks and day ticks appear in snapshot tests; pin the zone so a
// runner in UTC and a developer in Europe agree on every frame.
process.env.TZ = "Europe/Amsterdam";

// Host pressure is a property of the machine running the suite, not of the
// code under test: a loaded CI runner (load ratio 8+ on macOS) made `run`
// refuse and `doctor` report FAIL in tests that are not about the host guard.
// Every call without injected probes therefore sees an idle host. Tests of
// the guard itself inject their own probes, or mock this module themselves.
vi.mock("../src/host-health.js", async (original) => {
  const actual = await original<typeof import("../src/host-health.js")>();
  const idleHost: HostHealthDeps = {
    platform: "linux",
    loadavg: () => [0, 0, 0],
    cpuCount: () => 1,
    readFileImpl: (async () => { throw new Error("no PTY probe in tests"); }) as never,
    listProcessesImpl: async () => [],
  };
  return { ...actual, checkHostHealth: (policy?: HostGuardPolicy, deps?: HostHealthDeps) => actual.checkHostHealth(policy, deps ?? idleHost) };
});

// Whether an Antigravity IDE or agy runs on the machine is a property of the
// developer's host, not of the code under test: a running IDE would stop every
// daemon test's keepalive from starting. Tests of discovery itself inject their
// own process list to externalAntigravityServerPids().
vi.mock("../src/antigravity-discovery.js", async (original) => {
  const actual = await original<typeof import("../src/antigravity-discovery.js")>();
  return {
    ...actual,
    externalAntigravityServerPids: (options?: Parameters<typeof actual.externalAntigravityServerPids>[0]) =>
      actual.externalAntigravityServerPids({ list: async () => [], ...options }),
  };
});
