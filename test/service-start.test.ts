import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeServiceStart, installAndStartService, serviceContents, serviceLoadSteps, servicePath, type ServiceRunner } from "../src/service.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

// Every call goes through an injected runner and probe, so launchctl, systemctl and schtasks are
// never run and no daemon socket is opened. HEADROOM_HOME is set by the test worker's isolation.
async function fakeHome(): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(join(tmpdir(), "headroom-service-start-")); temporary.push(home);
  return { home, env: { ...process.env, HEADROOM_HOME: join(home, ".headroom") } };
}

function recorder(codes: (line: string) => number = () => 0): { runner: ServiceRunner; calls: string[] } {
  const calls: string[] = [];
  return { calls, runner: async (command, args) => { const line = [command, ...args].join(" "); calls.push(line); return { code: codes(line), output: codes(line) ? "Bootstrap failed: 5: Input/output error" : "" }; } };
}

const script = "/usr/local/bin/headroom";
const runtime = "/usr/local/bin/node";
const fast = { sleep: async () => undefined, intervalMs: 1, waitMs: 3, uid: 501 };

describe("install-service loads and starts the service", () => {
  it("darwin: unloads any old job, bootstraps into gui/<uid>, and confirms the daemon answers", async () => {
    const { home, env } = await fakeHome();
    const { runner, calls } = recorder();
    const result = await installAndStartService(script, "darwin", home, runtime, env, "tester", { ...fast, runner, probe: async () => calls.length >= 2 });
    expect(result.state).toBe("started");
    const path = servicePath("darwin", home, env);
    expect(calls).toEqual(["launchctl bootout gui/501/com.headroom.daemon", `launchctl bootstrap gui/501 ${path}`]);
    expect(await readFile(path, "utf8")).toBe(serviceContents(script, "darwin", runtime, "tester", home, env));
    expect(describeServiceStart(result)).toContain("service loaded; the daemon is answering");
  });

  it("linux: daemon-reload then enable --now, and restarts only when a unit already existed", async () => {
    const { home, env } = await fakeHome();
    const first = recorder();
    await installAndStartService(script, "linux", home, runtime, env, "tester", { ...fast, runner: first.runner, probe: async () => first.calls.length > 0 });
    expect(first.calls).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now headroom.service"]);
    // A different runtime rewrites the unit, so the running service has to be restarted to pick it up.
    const second = recorder();
    await installAndStartService(script, "linux", home, "/opt/other/node", env, "tester", { ...fast, runner: second.runner, probe: async () => second.calls.length > 0 });
    expect(second.calls).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now headroom.service", "systemctl --user restart headroom.service"]);
  });

  // Steps only: running the whole install for win32 on a posix host would write to a
  // backslash-named path in the working directory.
  it("win32: creates the task from the XML and runs it", () => {
    expect(serviceLoadSteps("win32", "C:\\h\\headroom-daemon.xml", 0, false)).toEqual([
      { command: "schtasks", args: ["/Create", "/TN", "Headroom Daemon", "/XML", "C:\\h\\headroom-daemon.xml", "/F"] },
      { command: "schtasks", args: ["/Run", "/TN", "Headroom Daemon"] },
    ]);
  });

  it("does not fail when launchd refuses (no GUI session over ssh): the file is written, the reason and the manual command are reported", async () => {
    const { home, env } = await fakeHome();
    const { runner } = recorder((line) => line.startsWith("launchctl bootstrap") ? 5 : 0);
    const result = await installAndStartService(script, "darwin", home, runtime, env, "tester", { ...fast, runner, probe: async () => false });
    expect(result.state).toBe("not-loaded");
    expect(result.reason).toContain("exited 5");
    expect(result.reason).toContain("Input/output error");
    expect(result.manual).toBe(`launchctl bootstrap gui/$(id -u) ${servicePath("darwin", home, env)}`);
    expect(await readFile(servicePath("darwin", home, env), "utf8")).toContain("com.headroom.daemon");
    const lines = describeServiceStart(result).join("\n");
    expect(lines).toContain("could not load the service");
    expect(lines).toContain(result.manual);
  });

  it("reports a loaded service whose daemon never answers within the bounded wait", async () => {
    const { home, env } = await fakeHome();
    const { runner } = recorder();
    const probe = vi.fn(async () => false);
    const result = await installAndStartService(script, "darwin", home, runtime, env, "tester", { ...fast, runner, probe });
    expect(result.state).toBe("unconfirmed");
    expect(probe.mock.calls.length).toBeLessThan(10);
    expect(describeServiceStart(result).join("\n")).toContain("has not answered yet");
  });

  it("says 'already installed and running' and touches nothing when the plist is unchanged and the daemon answers", async () => {
    const { home, env } = await fakeHome();
    const path = servicePath("darwin", home, env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serviceContents(script, "darwin", runtime, "tester", home, env));
    const { runner, calls } = recorder();
    const result = await installAndStartService(script, "darwin", home, runtime, env, "tester", { ...fast, runner, probe: async () => true });
    expect(result.state).toBe("already-running");
    expect(calls).toEqual([]);
    expect(describeServiceStart(result)).toEqual(["already installed and running"]);
  });

  it("reloads when the plist is unchanged but the daemon is not answering", async () => {
    const { home, env } = await fakeHome();
    const path = servicePath("darwin", home, env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serviceContents(script, "darwin", runtime, "tester", home, env));
    const { runner, calls } = recorder();
    let answering = false;
    await installAndStartService(script, "darwin", home, runtime, env, "tester", { ...fast, runner, probe: async () => { const was = answering; answering = calls.length > 0; return was; } });
    expect(calls).toHaveLength(2);
  });
});
