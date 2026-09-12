import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNpmInstall, runUpdate, type SpawnResult } from "../src/update.js";
import { headroomVersion } from "../src/version.js";

// The executable name the platform under test resolves: npm.cmd on Windows.
const npmName = process.platform === "win32" ? "npm.cmd" : "npm";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function seededHome(prefix = "headroom-update-install-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function registryFetch(version: string): typeof fetch {
  return (async () => json({ version })) as unknown as typeof fetch;
}

function releaseNotesFetch(version: string, body: string): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = (input as Request).url ?? String(input);
    if (url.includes("registry.npmjs.org")) return json({ version });
    return json({ body });
  }) as unknown as typeof fetch;
}

/** A minimal stand-in for a spawned child process: emits the requested
 * stdout/stderr chunks and then a close event on the next microtask, exactly
 * what update.ts's runCommand() reads from a real ChildProcess. */
function fakeChild(code: number, stdout = "", stderr = ""): ReturnType<typeof spawn> {
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn> & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter() as unknown as typeof child.stdout;
  child.stderr = new EventEmitter() as unknown as typeof child.stderr;
  queueMicrotask(() => {
    if (stdout) (child.stdout as unknown as EventEmitter).emit("data", Buffer.from(stdout));
    if (stderr) (child.stderr as unknown as EventEmitter).emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

/** Records every command+args it is called with, and never touches a real
 * process -- npm is never really invoked and nothing is ever really
 * installed, matching the project's hard rule. */
function spySpawn(results: SpawnResult[] = []): { spawnFn: typeof spawn; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  let index = 0;
  const spawnFn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args: [...args] });
    const result = results[index] ?? { code: 0, stdout: "", stderr: "" };
    index += 1;
    return fakeChild(result.code, result.stdout, result.stderr);
  }) as unknown as typeof spawn;
  return { spawnFn, calls };
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
  return { logs, restore: () => spy.mockRestore() };
}

describe("runNpmInstall uses the platform's real executable name", () => {
  it("spawns npm.cmd, not npm, on Windows", async () => {
    const spy = spySpawn([{ code: 0, stdout: "", stderr: "" }]);
    await runNpmInstall("1.2.3", "win32", spy.spawnFn);
    expect(spy.calls).toEqual([{ command: "npm.cmd", args: ["install", "-g", "headroomd@1.2.3"] }]);
  });

  it("spawns plain npm on macOS/Linux with the exact argument vector", async () => {
    const spy = spySpawn([{ code: 0, stdout: "", stderr: "" }]);
    await runNpmInstall("1.2.3", "darwin", spy.spawnFn);
    expect(spy.calls).toEqual([{ command: "npm", args: ["install", "-g", "headroomd@1.2.3"] }]);
  });
});

describe("headroom update: already current", () => {
  it("prints current/latest and never spawns anything", async () => {
    const current = await headroomVersion();
    const home = await seededHome();
    const spy = spySpawn();
    const { logs, restore } = captureLog();
    let code: number;
    try { code = await runUpdate([], { fetch: registryFetch(current), spawnFn: spy.spawnFn, home }); }
    finally { restore(); }
    expect(code).toBe(0);
    expect(spy.calls).toHaveLength(0);
    expect(logs.some((line) => line.includes("already the latest version"))).toBe(true);
  });
});

describe("headroom update --dry-run", () => {
  it("never spawns anything and prints what it would run", async () => {
    const home = await seededHome();
    const spy = spySpawn();
    const { logs, restore } = captureLog();
    let code: number;
    try { code = await runUpdate(["--dry-run"], { fetch: registryFetch("999.0.0"), spawnFn: spy.spawnFn, home }); }
    finally { restore(); }
    expect(code).toBe(0);
    expect(spy.calls).toHaveLength(0);
    expect(logs.some((line) => line.includes(`would run: ${npmName} install -g headroomd@999.0.0`))).toBe(true);
  });
});

describe("headroom update --notes", () => {
  it("prints the fetched release body before asking, and Enter (declining) installs nothing", async () => {
    const home = await seededHome();
    const spy = spySpawn();
    const { logs, restore } = captureLog();
    let code: number;
    try {
      code = await runUpdate(["--notes"], {
        fetch: releaseNotesFetch("999.0.0", "### Added\n- a new thing entirely\n"),
        spawnFn: spy.spawnFn,
        home,
        askYesNo: async () => false, // Enter means No
      });
    } finally { restore(); }
    expect(code).toBe(0);
    expect(spy.calls).toHaveLength(0);
    expect(logs).toContain("### Added\n- a new thing entirely");
    expect(logs).toContain("Not installing.");
  });

  it("--yes skips the question and installs without ever calling askYesNo", async () => {
    const home = await seededHome();
    const asked = vi.fn(async () => false);
    const spy = spySpawn([
      { code: 0, stdout: "", stderr: "" }, // npm install
      { code: 0, stdout: "1.2.3\n", stderr: "" }, // headroom --version, the freshly installed binary
    ]);
    const { logs, restore } = captureLog();
    let code: number;
    try {
      code = await runUpdate(["--notes", "--yes"], {
        fetch: releaseNotesFetch("999.0.0", "notes body"),
        spawnFn: spy.spawnFn,
        home,
        askYesNo: asked,
      });
    } finally { restore(); }
    expect(code).toBe(0);
    expect(asked).not.toHaveBeenCalled();
    expect(spy.calls[0]).toEqual({ command: npmName, args: ["install", "-g", "headroomd@999.0.0"] });
    expect(logs.some((line) => line.includes("headroom 1.2.3 installed"))).toBe(true);
  });
});

describe("headroom update: npm install failure", () => {
  it("exits 1 and never claims success", async () => {
    const home = await seededHome();
    const spy = spySpawn([{ code: 1, stdout: "", stderr: "EACCES: permission denied" }]);
    const { logs, restore } = captureLog();
    let code: number;
    try { code = await runUpdate([], { fetch: registryFetch("999.0.0"), spawnFn: spy.spawnFn, home }); }
    finally { restore(); }
    expect(code).toBe(1);
    expect(logs.some((line) => line.includes("installed"))).toBe(false);
  });
});

describe("headroom update: service restart", () => {
  for (const [platform, serviceParts, restart] of [
    ["darwin", ["Library", "LaunchAgents", "com.headroom.daemon.plist"], { command: "launchctl", args: ["kickstart", "-k", `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/com.headroom.daemon`] }],
    ["linux", [".config", "systemd", "user", "headroom.service"], { command: "systemctl", args: ["--user", "restart", "headroom.service"] }],
  ] as const) {
    it(`finds and restarts the ${platform} service from the OS home, not the state directory`, async () => {
      const root = await mkdtemp(join(tmpdir(), "headroom-update-service-"));
      temporary.push(root);
      const home = join(root, "state");
      const userHome = join(root, "user");
      const service = join(userHome, ...serviceParts);
      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(dirname(service), { recursive: true, mode: 0o700 });
      await writeFile(service, "service", { mode: 0o600 });
      const spy = spySpawn([
        { code: 0, stdout: "", stderr: "" }, // npm install
        { code: 0, stdout: "", stderr: "" }, // service restart
        { code: 0, stdout: "1.2.3\n", stderr: "" }, // installed binary
      ]);

      const code = await runUpdate([], {
        fetch: registryFetch("999.0.0"),
        spawnFn: spy.spawnFn,
        home,
        userHome,
        platform,
      });

      expect(code).toBe(0);
      expect(spy.calls).toEqual([
        { command: platform === "win32" ? "npm.cmd" : "npm", args: ["install", "-g", "headroomd@999.0.0"] },
        restart,
        { command: platform === "win32" ? "headroom.cmd" : "headroom", args: ["--version"] },
      ]);
    });
  }

  for (const [state, endCode] of [["running", 0], ["stopped", 1]] as const) {
    it(`ends a ${state} Windows task before starting the updated daemon`, async () => {
      const lstatFn = vi.fn(async (path: string) => {
        expect(path).toBe("D:\\headroom-state\\headroom-daemon.xml");
        return { isFile: () => true };
      });
      const spy = spySpawn([
        { code: 0, stdout: "", stderr: "" }, // npm install
        { code: endCode, stdout: "", stderr: "" }, // /End: succeeds only while running
        { code: 0, stdout: "", stderr: "" }, // /Run starts the updated task
        { code: 0, stdout: "1.2.3\n", stderr: "" }, // installed binary
      ]);

      const code = await runUpdate([], {
        fetch: registryFetch("999.0.0"),
        spawnFn: spy.spawnFn,
        home: "D:\\headroom-state",
        userHome: "C:\\Users\\headroom-update",
        platform: "win32",
        lstatFn: lstatFn as unknown as typeof lstat,
      });

      expect(code).toBe(0);
      expect(lstatFn).toHaveBeenCalledTimes(1);
      expect(spy.calls).toEqual([
        { command: "npm.cmd", args: ["install", "-g", "headroomd@999.0.0"] },
        { command: "schtasks", args: ["/End", "/TN", "Headroom Daemon"] },
        { command: "schtasks", args: ["/Run", "/TN", "Headroom Daemon"] },
        { command: "headroom.cmd", args: ["--version"] },
      ]);
    });
  }
});

// Real spawn(), a real fake npm executable on PATH, no injected spawnFn: this
// is the one end-to-end proof that the install path calls the platform's
// actual npm as an argument vector (never a shell string) and never touches
// the real npm registry or a real global install. Shebang scripts do not run
// on Windows, so this is POSIX-only; runNpmInstall's own Windows executable
// name is covered above without needing a real process.
describe.skipIf(process.platform === "win32")("headroom update: real spawn against a fake npm and headroom on PATH", () => {
  it("spawns npm with the exact argument vector and prints the freshly installed binary's own version", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "headroom-update-bin-"));
    temporary.push(binDir);
    const argsFile = join(binDir, "npm-args.txt");
    await writeFile(join(binDir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`, "utf8");
    await chmod(join(binDir, "npm"), 0o755);
    await writeFile(join(binDir, "headroom"), "#!/bin/sh\necho 2.0.0\nexit 0\n", "utf8");
    await chmod(join(binDir, "headroom"), 0o755);

    const home = await seededHome();
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
    const { logs, restore } = captureLog();
    let code: number;
    try {
      code = await runUpdate([], { fetch: registryFetch("2.0.0"), home });
    } finally {
      restore();
      process.env.PATH = previousPath;
    }
    expect(code).toBe(0);
    const recordedArgs = (await readFile(argsFile, "utf8")).trim().split("\n");
    expect(recordedArgs).toEqual(["install", "-g", "headroomd@2.0.0"]);
    expect(logs.some((line) => line.includes("headroom 2.0.0 installed"))).toBe(true);
  });
});
