import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = join(__dirname, "..", "scripts", "record-antigravity-fixture.sh");

// Never builds the real engine and never touches agy: the live tests run the
// script from a scratch repo layout against a stub "engine".
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

  it("leaves no engine process behind when the wrapper is terminated", async () => {
    const root = fakeRepo('#!/bin/bash\necho $$ > "$0.pid"\nsleep 300 &\necho $! > "$0.child"\nwait\n');
    const engine = join(root, "bin", "engine", "darwin", "headroom-engine");
    // /bin/bash is bash 3.2 on macOS, the oldest shell the script must support.
    const wrapper = spawn("/bin/bash", [join(root, "scripts", "record-antigravity-fixture.sh"), "x"], { stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => wrapper.on("exit", (code) => resolve(code)));
    expect(await waitFor(() => existsSync(`${engine}.child`) && readFileSync(`${engine}.child`, "utf8").trim() !== "")).toBe(true);
    const enginePid = Number(readFileSync(`${engine}.pid`, "utf8"));
    const childPid = Number(readFileSync(`${engine}.child`, "utf8"));
    expect(alive(enginePid) && alive(childPid)).toBe(true);
    try {
      wrapper.kill("SIGTERM");
      expect(await exited).toBe(130);
      expect(await waitFor(() => !alive(enginePid) && !alive(childPid), 5_000)).toBe(true);
    } finally {
      for (const pid of [enginePid, childPid]) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 30_000);
});
