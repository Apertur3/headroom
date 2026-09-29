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
    // Only the service manager's own read-only state query; nothing is rewritten or reloaded.
    expect(calls).toEqual(["launchctl print gui/501/com.headroom.daemon"]);
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
    expect(calls).toHaveLength(3);
  });

  it("reloads when the plist is unchanged and a daemon answers, but the service manager does not have the service (--no-start, then a foreground daemon)", async () => {
    const { home, env } = await fakeHome();
    const path = servicePath("darwin", home, env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serviceContents(script, "darwin", runtime, "tester", home, env));
    const { runner, calls } = recorder((line) => line.startsWith("launchctl print") ? 113 : 0);
    const result = await installAndStartService(script, "darwin", home, runtime, env, "tester", { ...fast, runner, probe: async () => true });
    expect(result.state).toBe("started");
    expect(calls).toEqual(["launchctl print gui/501/com.headroom.daemon", "launchctl bootout gui/501/com.headroom.daemon", `launchctl bootstrap gui/501 ${path}`]);
  });

  it("linux: asks systemd whether the unit is active and enabled before calling it already running", async () => {
    const { home, env } = await fakeHome();
    const path = servicePath("linux", home, env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serviceContents(script, "linux", runtime, "tester", home, env));
    const { runner, calls } = recorder((line) => line.includes("is-enabled") ? 1 : 0);
    const result = await installAndStartService(script, "linux", home, runtime, env, "tester", { ...fast, runner, probe: async () => true });
    expect(result.state).toBe("started");
    expect(calls.slice(0, 2)).toEqual(["systemctl --user is-active headroom.service", "systemctl --user is-enabled headroom.service"]);
    expect(calls).toContain("systemctl --user enable --now headroom.service");
  });

  it("linux: a refused restart of a replaced unit is reported as not started, with the command's output", async () => {
    const { home, env } = await fakeHome();
    const path = servicePath("linux", home, env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "[Service]\nold\n");
    const { runner } = recorder((line) => line.includes(" restart ") ? 1 : 0);
    const result = await installAndStartService(script, "linux", home, runtime, env, "tester", { ...fast, runner, probe: async () => true });
    expect(result.state).toBe("not-loaded");
    expect(result.reason).toContain("restart headroom.service exited 1");
    expect(result.reason).toContain("Bootstrap failed");
  });

  it("win32: replacing a task ends the old one and waits for the old daemon to stop before /Run", () => {
    const steps = serviceLoadSteps("win32", "C:\\h\\headroom-daemon.xml", 0, true);
    expect(steps.map((step) => step.args[0])).toEqual(["/Create", "/End", "/Run"]);
    expect(steps[1]).toMatchObject({ optional: true, confirmStopped: true });
  });

  const winQuery = (status: string, state: string) => `Folder: \\\nTaskName: \\Headroom Daemon\nStatus:                               ${status}\nScheduled Task State:                 ${state}\n`;

  async function windowsReplace(query: string, endCode: number, endOutput: string, probe: () => Promise<boolean>, unchanged = true) {
    const { home, env } = await fakeHome();
    const path = servicePath("win32", home, env); temporary.push(path); // win32 paths are backslash-joined, so on posix this is a stray file in the cwd
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, unchanged ? serviceContents(script, "win32", runtime, "tester", home, env) : "old");
    const calls: string[] = [];
    const runner: ServiceRunner = async (command, args) => {
      const line = [command, ...args].join(" "); calls.push(line);
      if (args[0] === "/Query") return { code: 0, output: query };
      if (args[0] === "/End") return { code: endCode, output: endOutput };
      return { code: 0, output: "" };
    };
    const result = await installAndStartService(script, "win32", home, runtime, env, "tester", { ...fast, stopWaitMs: 50, runner, probe });
    return { result, calls };
  }

  it("win32: a disabled or idle task is not 'already running' even though /Query succeeds and a daemon answers", async () => {
    for (const query of [winQuery("Running", "Disabled"), winQuery("Ready", "Enabled"), "GARBAGE localized output"]) {
      const { result, calls } = await windowsReplace(query, 0, "", async () => true);
      expect(result.state).not.toBe("already-running");
      expect(calls.some((call) => call.startsWith("schtasks /Create"))).toBe(true);
    }
  });

  it("win32: an enabled, running task with an answering daemon is already running", async () => {
    const { result, calls } = await windowsReplace(winQuery("Running", "Enabled"), 0, "", async () => true);
    expect(result.state).toBe("already-running");
    expect(calls).toEqual(["schtasks /Query /TN Headroom Daemon /FO LIST /V"]);
  });

  it("win32: a failed /End other than 'not running' reports not-loaded and never runs the task", async () => {
    const { result, calls } = await windowsReplace(winQuery("Ready", "Disabled"), 1, "ERROR: Access is denied.", async () => false);
    expect(result.state).toBe("not-loaded");
    expect(result.reason).toContain("Access is denied");
    expect(calls.some((call) => call.startsWith("schtasks /Run"))).toBe(false);
  });

  it("win32: one failed health probe is not enough to call the old daemon stopped", async () => {
    const answers = [false, true, true, true, true, true, true, true, true, true, true, true];
    const probe = vi.fn(async () => answers.shift() ?? true);
    const { result, calls } = await windowsReplace(winQuery("Ready", "Disabled"), 0, "", probe, false);
    expect(result.state).toBe("not-loaded");
    expect(result.reason).toContain("did not stop the old daemon");
    expect(calls.some((call) => call.startsWith("schtasks /Run"))).toBe(false);
  });

  it("win32: consecutive failed probes let /Run go ahead", async () => {
    let ran = false;
    const probe = async () => ran;
    const { home, env } = await fakeHome();
    const path = servicePath("win32", home, env); temporary.push(path); // win32 paths are backslash-joined, so on posix this is a stray file in the cwd
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "old");
    const runner: ServiceRunner = async (_command, args) => { if (args[0] === "/Run") ran = true; return { code: 0, output: "" }; };
    const result = await installAndStartService(script, "win32", home, runtime, env, "tester", { ...fast, stopWaitMs: 50, runner, probe });
    expect(result.state).toBe("started");
  });

  it("bounds the whole health wait by wall-clock time even when each probe is slow", async () => {
    const { home, env } = await fakeHome();
    const { runner } = recorder();
    const started = Date.now();
    const result = await installAndStartService(script, "darwin", home, runtime, env, "tester", { runner, sleep: async () => undefined, intervalMs: 1, waitMs: 60, uid: 501, probe: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return false; } });
    expect(result.state).toBe("unconfirmed");
    // Without a deadline: 61 probes x 30 ms of real time.
    expect(Date.now() - started).toBeLessThan(600);
  });
});
