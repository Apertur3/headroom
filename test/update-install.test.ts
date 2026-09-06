import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNpmInstall, runUpdate, type SpawnResult } from "../src/update.js";
import { headroomVersion } from "../src/version.js";

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
    expect(logs.some((line) => line.includes("would run: npm install -g headroomd@999.0.0"))).toBe(true);
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
    expect(spy.calls[0]).toEqual({ command: "npm", args: ["install", "-g", "headroomd@999.0.0"] });
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
