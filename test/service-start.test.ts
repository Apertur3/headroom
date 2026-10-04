import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeServiceStart, installAndStartService, serviceContents, serviceLoadSteps, servicePath, staleDaemonReason, type DaemonIdentity, type ServiceRunner } from "../src/service.js";

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
// Windows: the daemon this CLI would start, and seams so no test dials a real pipe.
const current: DaemonIdentity = { version: "0.2.7", socket: "\\\\.\\pipe\\headroom-0123456789abcdef" };
const windowsSeams = { requestShutdown: async () => "absent" as const, identify: async () => current, expected: current };

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

  async function windowsReplace(state: string, endCode: number, endOutput: string, probe: () => Promise<boolean>, unchanged = true) {
    const { home, env } = await fakeHome();
    const path = servicePath("win32", home, env); temporary.push(path); // win32 paths are backslash-joined, so on posix this is a stray file in the cwd
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, unchanged ? serviceContents(script, "win32", runtime, "tester", home, env) : "old");
    const calls: string[] = [];
    const runner: ServiceRunner = async (command, args) => {
      const line = [command, ...args].join(" "); calls.push(line);
      if (command === "powershell") return { code: 0, output: `${state}\r\n` };
      if (args[0] === "/Query") return { code: 0, output: "Status: Wird ausgeführt\nStatus des geplanten Tasks: Aktiviert" }; // German schtasks text, never parsed
      if (args[0] === "/End") return { code: endCode, output: endOutput };
      return { code: 0, output: "" };
    };
    const result = await installAndStartService(script, "win32", home, runtime, env, "tester", { ...fast, ...windowsSeams, stopWaitMs: 50, runner, probe });
    return { result, calls };
  }

  it("win32: a disabled, idle, queued or unknown task is not 'already running' even though a daemon answers", async () => {
    for (const state of ["Disabled", "Ready", "Queued", "Unknown", "GARBAGE"]) {
      const { result, calls } = await windowsReplace(state, 0, "", async () => true);
      expect(result.state).not.toBe("already-running");
      expect(calls.some((call) => call.startsWith("schtasks /Create"))).toBe(true);
    }
  });

  it("win32: a Running task with an answering daemon is already running, whatever language schtasks speaks", async () => {
    const { result, calls } = await windowsReplace("Running", 0, "", async () => true);
    expect(result.state).toBe("already-running");
    expect(calls).toEqual(["powershell -NoProfile -NonInteractive -Command (Get-ScheduledTask -TaskName 'Headroom Daemon').State"]);
    expect(calls.some((call) => call.startsWith("schtasks"))).toBe(false);
  });

  it("win32: a failed /End other than 'not running' reports not-loaded and never runs the task", async () => {
    const { result, calls } = await windowsReplace("Ready", 1, "ERROR: Access is denied.", async () => false);
    expect(result.state).toBe("not-loaded");
    expect(result.reason).toContain("Access is denied");
    expect(calls.some((call) => call.startsWith("schtasks /Run"))).toBe(false);
  });

  it("win32: one failed health probe is not enough to call the old daemon stopped", async () => {
    const answers = [false, true, true, true, true, true, true, true, true, true, true, true];
    const probe = vi.fn(async () => answers.shift() ?? true);
    const { result, calls } = await windowsReplace("Ready", 0, "", probe, false);
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
    const result = await installAndStartService(script, "win32", home, runtime, env, "tester", { ...fast, ...windowsSeams, stopWaitMs: 50, runner, probe });
    expect(result.state).toBe("started");
  });

  it("win32: replacing a task asks the old daemon to shut down before the backup /End and /Run", async () => {
    const { home, env } = await fakeHome();
    const path = servicePath("win32", home, env); temporary.push(path); // win32 paths are backslash-joined, so on posix this is a stray file in the cwd
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "old");
    const events: string[] = [];
    let answering = true;
    const runner: ServiceRunner = async (command, args) => { events.push([command, ...args].join(" ")); if (args[0] === "/Run") answering = true; return { code: 0, output: "" }; };
    const requestShutdown = async () => { events.push("shutdown"); answering = false; return "accepted" as const; };
    const result = await installAndStartService(script, "win32", home, runtime, env, "tester", { ...fast, ...windowsSeams, requestShutdown, stopWaitMs: 50, runner, probe: async () => answering });
    expect(result.state).toBe("started");
    expect(events.map((event) => event.split(" ").slice(0, 2).join(" "))).toEqual(["schtasks /Create", "shutdown", "schtasks /End", "schtasks /Run"]);
  });

  describe("win32: restart an older daemon after an in-place upgrade", () => {
    /** The task definition is unchanged and Running, and a daemon answers: the state after
     * `npm i -g` over a running service. `running` is what that daemon says about itself. */
    async function upgraded(running: DaemonIdentity | undefined, shutdown: "accepted" | "unsupported" = "accepted", answersAfterRun: (identity: DaemonIdentity) => DaemonIdentity = () => current) {
      const { home, env } = await fakeHome();
      const path = servicePath("win32", home, env); temporary.push(path); // win32 paths are backslash-joined, so on posix this is a stray file in the cwd
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, serviceContents(script, "win32", runtime, "tester", home, env));
      const events: string[] = [];
      let daemon: DaemonIdentity | undefined = running;
      let stopped = false;
      const runner: ServiceRunner = async (command, args) => {
        if (command === "powershell") return { code: 0, output: stopped ? "Ready" : "Running" };
        events.push([command, ...args].join(" "));
        if (args[0] === "/Run" && stopped) daemon = answersAfterRun(current);
        return { code: 0, output: "" };
      };
      const requestShutdown = vi.fn(async () => {
        events.push("shutdown");
        if (shutdown === "accepted") { daemon = undefined; stopped = true; }
        return shutdown;
      });
      const kill = vi.spyOn(process, "kill");
      try {
        const result = await installAndStartService(script, "win32", home, runtime, env, "tester", { ...fast, stopWaitMs: 5, requestShutdown, identify: async () => daemon, expected: current, runner, probe: async () => daemon !== undefined || running === undefined });
        expect(kill).not.toHaveBeenCalled();
        return { result, events, requestShutdown };
      } finally { kill.mockRestore(); }
    }

    it("leaves a daemon with this version on this pipe alone", async () => {
      const { result, events, requestShutdown } = await upgraded(current);
      expect(result.state).toBe("already-running");
      expect(events).toEqual([]);
      expect(requestShutdown).not.toHaveBeenCalled();
    });

    it("leaves a daemon it cannot identify alone", async () => {
      const { result, requestShutdown } = await upgraded(undefined);
      expect(result.state).toBe("already-running");
      expect(requestShutdown).not.toHaveBeenCalled();
    });

    it("restarts a daemon on the older pipe name: shutdown, backup /End, /Run, confirmed on the new pipe", async () => {
      const { result, events } = await upgraded({ version: "0.2.7", socket: "\\\\.\\pipe\\headroom-user-0123abcd" });
      expect(result.state).toBe("restarted");
      expect(events).toEqual(["shutdown", "schtasks /End /TN Headroom Daemon", "schtasks /Run /TN Headroom Daemon"]);
      expect(describeServiceStart(result)[0]).toContain("restarted the daemon so it runs this version (the running daemon serves the older pipe name");
    });

    it("keeps waiting while an accepted shutdown is still draining at 10 s, then restarts (no unshortened wait is cut short)", async () => {
      const { home, env } = await fakeHome();
      const path = servicePath("win32", home, env); temporary.push(path); // win32 paths are backslash-joined, so on posix this is a stray file in the cwd
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, serviceContents(script, "win32", runtime, "tester", home, env));
      let now = 1_000_000;
      let stoppingSince: number | undefined;
      let running: DaemonIdentity | undefined = { version: "0.2.6", socket: current.socket };
      const events: string[] = [];
      const runner: ServiceRunner = async (command, args) => {
        if (command === "powershell") return { code: 0, output: "Running" };
        events.push(args[0]);
        if (args[0] === "/Run" && running === undefined) running = current;
        return { code: 0, output: "" };
      };
      const probe = async () => {
        // A slow graceful stop: the old daemon answers until 15 s after it accepted the request.
        if (stoppingSince !== undefined && running?.version === "0.2.6" && now - stoppingSince >= 15_000) running = undefined;
        return running !== undefined;
      };
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const result = await installAndStartService(script, "win32", home, runtime, env, "tester", {
          sleep: async (ms) => { now += ms; }, intervalMs: 500, uid: 501, runner, probe, expected: current,
          identify: async () => { await probe(); return running; },
          requestShutdown: async () => { stoppingSince = now; return "accepted"; },
        });
        expect(result.state).toBe("restarted");
        expect(events).toEqual(["/End", "/Run"]);
        expect(now - stoppingSince!).toBeGreaterThan(15_000);
      } finally { clock.mockRestore(); }
    });

    it("restarts a daemon running another version on the same pipe", async () => {
      const { result, events } = await upgraded({ version: "0.2.6", socket: current.socket });
      expect(result.state).toBe("restarted");
      expect(result.reason).toBe("the running daemon is version 0.2.6, this is 0.2.7");
      expect(events[0]).toBe("shutdown");
    });

    it("keeps an older daemon that cannot take the shutdown request, never runs the task, and says how to switch", async () => {
      const { result, events } = await upgraded({ socket: "\\\\.\\pipe\\headroom-user-0123abcd" }, "unsupported");
      expect(result.state).toBe("stale");
      expect(events).toEqual(["shutdown", "schtasks /End /TN Headroom Daemon"]);
      const lines = describeServiceStart(result).join("\n");
      expect(lines).toContain("it is from a version without the shutdown request");
      expect(lines).toContain("stop the node.exe running `headroom daemon`");
    });

    it("runs the task once more when the restarted daemon does not answer on the new pipe, then reports it unconfirmed", async () => {
      const { result, events } = await upgraded({ version: "0.2.6", socket: current.socket }, "accepted", () => ({ version: "0.2.6", socket: "\\\\.\\pipe\\other" }));
      expect(result.state).toBe("unconfirmed");
      expect(events.filter((event) => event.includes("/Run"))).toHaveLength(2);
    });

    it("does not change macOS: an unchanged plist with an answering daemon is already running, whatever it reports", async () => {
      const { home, env } = await fakeHome();
      const path = servicePath("darwin", home, env);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, serviceContents(script, "darwin", runtime, "tester", home, env));
      const identify = vi.fn(async () => ({ version: "0.0.1", socket: "/elsewhere" }));
      const { runner } = recorder();
      const result = await installAndStartService(script, "darwin", home, runtime, env, "tester", { ...fast, runner, identify, expected: current, probe: async () => true });
      expect(result.state).toBe("already-running");
      expect(identify).not.toHaveBeenCalled();
    });
  });

  it("staleDaemonReason: the same version and pipe is current; another pipe, version or no version is stale; nothing readable is never stale", () => {
    expect(staleDaemonReason(current, current)).toBeUndefined();
    expect(staleDaemonReason(undefined, current)).toBeUndefined();
    expect(staleDaemonReason({ ...current, socket: "\\\\.\\pipe\\old" }, current)).toContain("older pipe name");
    expect(staleDaemonReason({ ...current, version: "0.2.6" }, current)).toContain("version 0.2.6");
    expect(staleDaemonReason({ socket: current.socket }, current)).toContain("predates version 0.2.7");
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
