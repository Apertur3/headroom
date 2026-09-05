import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childEnvironment, forwardSignal, policyProxyConfigured } from "../bin/headroom.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const PROXY_KEYS = ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

describe("launcher proxy stripping", () => {
  it("reads only the proxy key from policy.toml, ignoring everything else and a missing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-launcher-policy-")); temporary.push(root);
    expect(policyProxyConfigured(root)).toBe(false);
    await writeFile(join(root, "policy.toml"), "poll_interval_minutes = 5\n");
    expect(policyProxyConfigured(root)).toBe(false);
    await writeFile(join(root, "policy.toml"), 'poll_interval_minutes = 5\nproxy = "https://proxy.example:8080"\n');
    expect(policyProxyConfigured(root)).toBe(true);
    await writeFile(join(root, "policy.toml"), '# proxy = "https://commented-out.example"\n');
    expect(policyProxyConfigured(root)).toBe(false);
  });

  it("strips every proxy-related variable from the child environment by default", () => {
    const env = { PATH: "/usr/bin", NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://a", HTTPS_PROXY: "http://b", ALL_PROXY: "http://c", http_proxy: "http://d", https_proxy: "http://e", all_proxy: "http://f", UNRELATED: "keep-me" };
    const stripped = childEnvironment(env, false);
    for (const key of PROXY_KEYS) expect(stripped).not.toHaveProperty(key);
    expect(stripped.UNRELATED).toBe("keep-me");
    expect(stripped.PATH).toBe("/usr/bin");
    // The original object passed in is untouched.
    expect(env.HTTPS_PROXY).toBe("http://b");
  });

  it("leaves the environment untouched when policy.toml explicitly configures a proxy", () => {
    const env = { HTTPS_PROXY: "http://shell-proxy" };
    expect(childEnvironment(env, true)).toBe(env);
  });

  it("a child process spawned with childEnvironment()'s output sees no proxy variables, the same way the launcher spawns node", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-launcher-spawn-")); temporary.push(root);
    const probe = join(root, "print-proxy-env.mjs");
    await writeFile(probe, `const keys = ${JSON.stringify(PROXY_KEYS)};\nconsole.log(JSON.stringify(keys.filter((key) => key in process.env)));\n`);
    const shellEnv = { ...process.env, PATH: process.env.PATH ?? "", HTTP_PROXY: "http://shell-proxy:3128", HTTPS_PROXY: "http://shell-proxy:3128", NODE_USE_ENV_PROXY: "1" };
    const result = spawnSync(process.execPath, [probe], { env: childEnvironment(shellEnv, policyProxyConfigured(root)), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([]);
  });
});

describe("launcher signal forwarding", () => {
  it("forwards the signal to the child on POSIX, and shells out to `taskkill /T` on Windows instead of a bare kill()", () => {
    const posixChild = { pid: 4242, kill: vi.fn() };
    forwardSignal(posixChild, "SIGTERM", "darwin");
    expect(posixChild.kill).toHaveBeenCalledWith("SIGTERM");

    const windowsChild = { pid: 4343, kill: vi.fn() };
    const killTree = vi.fn();
    forwardSignal(windowsChild, "SIGTERM", "win32", killTree);
    expect(windowsChild.kill).not.toHaveBeenCalled();
    expect(killTree).toHaveBeenCalledWith("taskkill", ["/pid", "4343", "/T", "/F"]);
  });

  it("never throws when the child has already exited", () => {
    const gone = { pid: 1, kill: vi.fn(() => { throw new Error("ESRCH"); }) };
    expect(() => forwardSignal(gone, "SIGTERM", "darwin")).not.toThrow();
    const goneWindows = { pid: 1, kill: vi.fn() };
    const killTree = vi.fn(() => { throw new Error("gone"); });
    expect(() => forwardSignal(goneWindows, "SIGTERM", "win32", killTree)).not.toThrow();
  });

  // Regression for the bug where bin/headroom.js used spawnSync: killing the
  // launcher's own PID left a long-running child (most importantly the
  // daemon) orphaned, still holding the socket, because nothing forwarded
  // the signal to it. This spawns the real launcher against a fake
  // dist/cli.js that reports which signal it received (and its own pid, so
  // the Windows branch below can confirm it is really gone), then signals
  // the launcher (never the fake child directly).
  //
  // POSIX: `launcher.kill("SIGTERM")` reaches the launcher's own
  // `process.on("SIGTERM", ...)` handler, which calls forwardSignal() ->
  // child.kill("SIGTERM") -- real signal delivery, asserted end-to-end.
  //
  // Windows has no such delivery to assert: Node's own docs say
  // ChildProcess#kill() on Windows unconditionally terminates the target via
  // TerminateProcess, without ever running its signal handlers, so an
  // external `launcher.kill("SIGTERM")` here would never reach bin/headroom.js's
  // own handler and this test would just hang. The behavior actually worth
  // proving on Windows -- that forwardSignal()'s `taskkill /pid <pid> /T /F`
  // really terminates the launcher's whole process tree, not just the
  // launcher itself -- is exercised directly instead: call the real
  // (unstubbed) forwardSignal against the live launcher pid and confirm the
  // fake child, several process generations deep, is gone afterward.
  it("end-to-end: signaling the launcher process reaches its child, which is never orphaned", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-launcher-e2e-"));
    temporary.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const binDir = join(root, "bin");
    const distDir = join(root, "dist");
    await mkdir(binDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await writeFile(join(binDir, "headroom.js"), await readFile(new URL("../bin/headroom.js", import.meta.url), "utf8"));
    const receivedFile = join(root, "received-signal.txt");
    const pidFile = join(root, "child-pid.txt");
    await writeFile(join(distDir, "cli.js"), [
      "import { writeFileSync } from \"node:fs\";",
      "const receivedFile = process.argv[2];",
      "const pidFile = process.argv[3];",
      "writeFileSync(pidFile, String(process.pid));",
      "process.on(\"SIGTERM\", () => { writeFileSync(receivedFile, \"SIGTERM\"); process.exit(7); });",
      "process.stdout.write(\"ready\\n\");",
      "setInterval(() => {}, 1000);",
    ].join("\n"));

    const launcher = spawn(process.execPath, [join(binDir, "headroom.js"), receivedFile, pidFile], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("fake cli.js never reported ready")), 5000);
      launcher.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready")) { clearTimeout(timeout); resolve(); } });
    });

    if (process.platform === "win32") {
      const childPid = Number((await readFile(pidFile, "utf8")).trim());
      forwardSignal(launcher, "SIGTERM", "win32"); // the real killTree default (spawnSync + taskkill), not a stub
      await new Promise<void>((resolve) => launcher.on("exit", () => resolve()));
      // process.kill(pid, 0) is a liveness probe on every platform, Windows
      // included: it throws (ESRCH-equivalent) once the process is gone,
      // which taskkill /T /F guarantees for the whole tree it just killed.
      expect(() => process.kill(childPid, 0)).toThrow();
      return;
    }

    launcher.kill("SIGTERM"); // signals the LAUNCHER's own PID, exactly like an external `kill` or a service manager would
    const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => launcher.on("exit", (code, signal) => resolve([code, signal])));

    expect(await readFile(receivedFile, "utf8")).toBe("SIGTERM"); // the child was reached, not orphaned
    expect(code).toBe(7); // the launcher exits with the child's own exit code
  }, 10_000);
});
