import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { track, useProcessReaper } from "./helpers/mortal-process";

const execFileAsync = promisify(execFile);
const script = join(__dirname, "..", "scripts", "record-antigravity-fixture.sh");

// Never builds the real engine and never touches agy: the live tests run the
// script from a scratch repo layout against a stub "engine".
useProcessReaper();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeRepo(stub?: string): string {
  const root = mkdtempSync(join(tmpdir(), "headroom-record-test-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(script, join(root, "scripts", "record-antigravity-fixture.sh"));
  mkdirSync(join(root, "engine", "Sources", "HeadroomEngine"), { recursive: true });
  writeFileSync(join(root, "engine", "Sources", "HeadroomEngine", "x.swift"), "// src\n");
  writeFileSync(join(root, "engine", "Package.swift"), "// pkg\n");
  writeFileSync(join(root, "engine", "Package.resolved"), "{}\n");
  writeFileSync(join(root, "scripts", "build-native-engine.sh"), `#!/bin/bash\ntouch "${root}/BUILD_RAN"\n`);
  if (stub !== undefined) {
    mkdirSync(join(root, "bin", "engine", "darwin"), { recursive: true });
    const engine = join(root, "bin", "engine", "darwin", "headroom-engine");
    writeFileSync(engine, stub);
    chmodSync(engine, 0o755);
    const later = new Date(Date.now() + 60_000);
    utimesSync(engine, later, later);
  }
  return root;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe("record-antigravity-fixture.sh", () => {
  it("prints the engine command and stops before invoking it", async () => {
    const { stdout } = await execFileAsync("bash", [script, "--dry-run", "gemini-weekly-exhausted"]);
    expect(stdout).toMatch(/observe --principals <temp principals json> --record test\/fixtures\/antigravity\/\d{4}-\d{2}-\d{2}-gemini-weekly-exhausted\.json/);
    expect(stdout).not.toMatch(/would run: bash scripts\/build/);
  });

  it("rejects a label that is not kebab-case", async () => {
    await expect(execFileAsync("bash", [script, "--dry-run", "../escape"])).rejects.toMatchObject({ code: 2 });
  });

  it("stops with the build command when the engine is missing, and never builds", async () => {
    const root = fakeRepo();
    const result = await execFileAsync("bash", [join(root, "scripts", "record-antigravity-fixture.sh"), "x"]).catch((e) => e);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("bash scripts/build-native-engine.sh");
    expect(existsSync(join(root, "BUILD_RAN"))).toBe(false);
  });

  it("stops when the engine is older than the engine sources", async () => {
    const root = fakeRepo("#!/bin/bash\nexit 0\n");
    const engine = join(root, "bin", "engine", "darwin", "headroom-engine");
    const past = new Date(Date.now() - 60_000);
    utimesSync(engine, past, past);
    const result = await execFileAsync("bash", [join(root, "scripts", "record-antigravity-fixture.sh"), "x"]).catch((e) => e);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/older than the engine sources/);
    expect(existsSync(join(root, "BUILD_RAN"))).toBe(false);
  });

  const readPid = (file: string): number => Number(readFileSync(file, "utf8").trim());

  /** Spawns the wrapper against a stub engine. Every process is tracked for the
   * reaper and killed (group and all) in `stop`, which callers put in finally. */
  function start(stub: string) {
    const root = fakeRepo(stub);
    const engine = join(root, "bin", "engine", "darwin", "headroom-engine");
    const wrapper = spawn("/bin/bash", [join(root, "scripts", "record-antigravity-fixture.sh"), "x"], { stdio: "ignore" });
    track(wrapper.pid, root);
    const exited = new Promise<number | null>((resolve) => wrapper.on("exit", (code) => resolve(code)));
    const pids = (): number[] => [`${engine}.pid`, `${engine}.child`].filter((f) => existsSync(f)).map(readPid).filter((n) => Number.isInteger(n) && n > 1);
    const stop = () => {
      for (const pid of pids()) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader */ }
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
      if (wrapper.pid) try { process.kill(wrapper.pid, "SIGKILL"); } catch { /* gone */ }
    };
    return { root, engine, wrapper, exited, pids, stop };
  }

  // /bin/bash is bash 3.2 on macOS, the oldest shell the script must support.
  const term = '#!/bin/bash\necho $$ > "$0.pid"\nsleep 30 &\necho $! > "$0.child"\nwait\n';

  it("leaves no engine process behind when the wrapper is terminated", async () => {
    const run = start(term);
    try {
      expect(await waitFor(() => existsSync(`${run.engine}.child`) && readFileSync(`${run.engine}.child`, "utf8").trim() !== "")).toBe(true);
      const [enginePid, childPid] = [readPid(`${run.engine}.pid`), readPid(`${run.engine}.child`)];
      expect(alive(enginePid) && alive(childPid)).toBe(true);
      run.wrapper.kill("SIGTERM");
      expect(await run.exited).toBe(130);
      expect(await waitFor(() => !alive(enginePid) && !alive(childPid), 5_000)).toBe(true);
    } finally {
      run.stop();
    }
  }, 30_000);

  it("escalates to SIGKILL when the engine ignores TERM, within the grace period", async () => {
    const run = start('#!/bin/bash\ntrap "" TERM\necho $$ > "$0.pid"\nwhile :; do sleep 1; done\n');
    try {
      expect(await waitFor(() => existsSync(`${run.engine}.pid`) && readFileSync(`${run.engine}.pid`, "utf8").trim() !== "")).toBe(true);
      const enginePid = readPid(`${run.engine}.pid`);
      const began = Date.now();
      run.wrapper.kill("SIGTERM");
      expect(await run.exited).toBe(130);
      expect(Date.now() - began).toBeLessThan(9_000);
      expect(await waitFor(() => !alive(enginePid), 3_000)).toBe(true);
    } finally {
      run.stop();
    }
  }, 30_000);

  it("leaves no survivors when the wrapper is killed the moment the engine starts", async () => {
    for (let round = 0; round < 8; round++) {
      const run = start(term);
      try {
        // Signal as early as the wrapper has started the engine, inside the window
        // that used to precede trap installation.
        expect(await waitFor(() => existsSync(`${run.engine}.pid`) && readFileSync(`${run.engine}.pid`, "utf8").trim() !== "")).toBe(true);
        run.wrapper.kill("SIGTERM");
        await run.exited;
        await waitFor(() => existsSync(`${run.engine}.child`), 1_000);
        const pids = run.pids();
        expect(await waitFor(() => pids.every((pid) => !alive(pid)), 5_000)).toBe(true);
      } finally {
        run.stop();
      }
    }
  }, 60_000);
});
