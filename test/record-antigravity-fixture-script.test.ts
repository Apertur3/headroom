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
    const { stdout } = await execFileAsync("bash", [script, "--dry-run", "weekly-exhausted"]);
    expect(stdout).toMatch(/observe --principals \/dev\/stdin --record test\/fixtures\/antigravity\/\d{4}-\d{2}-\d{2}-weekly-exhausted\.json/);
    expect(stdout).not.toMatch(/would run: bash scripts\/build/);
  });

  it("rejects a label outside the fixed list, lists the allowed ones and never echoes the argument", async () => {
    for (const bad of ["../escape", "alice-smith", "sk-abc123", "Weekly-Exhausted"]) {
      const result = await execFileAsync("bash", [script, "--dry-run", bad]).catch((e) => e);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("weekly-exhausted, all-fresh, availability-only, loading, other");
      expect(result.stderr + result.stdout).not.toContain(bad);
    }
  });

  it("accepts each allowed label", async () => {
    for (const ok of ["weekly-exhausted", "all-fresh", "availability-only", "loading", "other"]) {
      const { stdout } = await execFileAsync("bash", [script, "--dry-run", ok]);
      expect(stdout).toContain(`-${ok}.json`);
    }
  });

  it("stops with the build command when the engine is missing, and never builds", async () => {
    const root = fakeRepo();
    const result = await execFileAsync("bash", [join(root, "scripts", "record-antigravity-fixture.sh"), "other"]).catch((e) => e);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("bash scripts/build-native-engine.sh");
    expect(existsSync(join(root, "BUILD_RAN"))).toBe(false);
  });

  it("stops when the engine is older than the engine sources", async () => {
    const root = fakeRepo("#!/bin/bash\nexit 0\n");
    const engine = join(root, "bin", "engine", "darwin", "headroom-engine");
    const past = new Date(Date.now() - 60_000);
    utimesSync(engine, past, past);
    const result = await execFileAsync("bash", [join(root, "scripts", "record-antigravity-fixture.sh"), "other"]).catch((e) => e);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/older than the engine sources/);
    expect(existsSync(join(root, "BUILD_RAN"))).toBe(false);
  });

  // The recorder is bash-only (darwin engine); the tests that spawn /bin/bash are skipped on Windows, where it does not exist.
  const readPid = (file: string): number => Number(readFileSync(file, "utf8").trim());

  // The stub writes its pid, then replaces itself with a sleep that has a hard
  // 10 s deadline, so a runner crash cannot leave it running. exec keeps the pid.
  const stub = '#!/bin/bash\necho $$ > "$0.pid"\ncat > "$0.stdin"\nexec sleep 10\n';

  function start() {
    const root = fakeRepo(stub);
    const engine = join(root, "bin", "engine", "darwin", "headroom-engine");
    const wrapper = spawn("/bin/bash", [join(root, "scripts", "record-antigravity-fixture.sh"), "other"], { stdio: ["pipe", "ignore", "ignore"] });
    track(wrapper.pid, root);
    const exited = new Promise<number | null>((resolve) => wrapper.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : null))));
    const pid = (): number | undefined => (existsSync(`${engine}.pid`) && readFileSync(`${engine}.pid`, "utf8").trim() !== "" ? readPid(`${engine}.pid`) : undefined);
    const stop = () => {
      const p = pid();
      if (p) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
      if (wrapper.pid) try { process.kill(wrapper.pid, "SIGKILL"); } catch { /* gone */ }
    };
    return { engine, wrapper, exited, pid, stop };
  }

  it.skipIf(process.platform === "win32")("execs the engine: the wrapper pid is the engine pid, so no child exists", async () => {
    const run = start();
    try {
      expect(await waitFor(() => run.pid() !== undefined)).toBe(true);
      expect(run.pid()).toBe(run.wrapper.pid);
    } finally {
      run.stop();
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("passes the principals JSON on stdin, with no secrets or arguments in it", async () => {
    const run = start();
    try {
      expect(await waitFor(() => existsSync(`${run.engine}.stdin`) && readFileSync(`${run.engine}.stdin`, "utf8").includes("antigravity"))).toBe(true);
      const parsed = JSON.parse(readFileSync(`${run.engine}.stdin`, "utf8"));
      expect(parsed).toHaveLength(1);
      expect(Object.keys(parsed[0]).sort()).toEqual(["id", "location", "vendor"]);
    } finally {
      run.stop();
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("leaves no survivors when the wrapper is terminated", async () => {
    const run = start();
    try {
      expect(await waitFor(() => run.pid() !== undefined)).toBe(true);
      const pid = run.pid() as number;
      expect(alive(pid)).toBe(true);
      run.wrapper.kill("SIGTERM");
      await run.exited;
      expect(await waitFor(() => !alive(pid), 5_000)).toBe(true);
    } finally {
      run.stop();
    }
  }, 30_000);
});
