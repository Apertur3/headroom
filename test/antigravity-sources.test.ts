import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agyLoginStateFromLog, AgyKeepaliveSupervisor, resolveAgyBinary } from "../src/antigravity-keepalive.js";
import { noDaemonObservations } from "../src/adapters/antigravity.js";
import { pollAccounts } from "../src/collector.js";
import type { ProviderAccount } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Antigravity one-shot reads with no daemon", () => {
  it("noDaemonObservations names the daemon-kept agy fix, across every meter and window, without contacting a vendor", () => {
    const account: ProviderAccount = { name: "antigravity", vendor: "antigravity", location: "agy", adapter: "native-ts" };
    const rows = noDaemonObservations(account, new Date("2026-09-03T12:00:00Z"));
    expect(rows).toHaveLength(4); // gemini + claude-gpt, each 5h and weekly
    expect(rows.every((item) => item.freshness === "failed" && item.reason === "no daemon; Antigravity needs the daemon-kept agy: run headroom install-service")).toBe(true);
  });

  it("pollAccounts with noDaemon skips the deprecated remote OAuth fallback entirely, never calling fetch", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-antigravity-nodaemon-")); temporary.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "accounts.toml"), [
      "[[accounts]]",
      'name = "antigravity"',
      'vendor = "antigravity"',
      'location = "agy"',
      'adapter = "native-ts"',
      "",
    ].join("\n"), { mode: 0o600 });
    const previousHome = process.env.HEADROOM_HOME;
    process.env.HEADROOM_HOME = root;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const result = await pollAccounts(undefined, { noDaemon: true });
      const rows = result.observations.filter((item) => item.principal_id === "antigravity");
      expect(rows).toHaveLength(4);
      expect(rows.every((item) => item.reason === "no daemon; Antigravity needs the daemon-kept agy: run headroom install-service")).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
    }
  });
});

describe("agy keepalive", () => {
  it("uses registry agy_path before the service-safe local and PATH candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-")); temporary.push(root);
    const local = join(root, ".local", "bin");
    await writeFile(join(root, "registry-agy"), "", { mode: 0o700 });
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "agy"), "", { mode: 0o700 });
    await chmod(join(local, "agy"), 0o700);
    expect(resolveAgyBinary(join(root, "registry-agy"), root, "/missing", "darwin")).toBe(join(root, "registry-agy"));
    expect(resolveAgyBinary(undefined, root, "/missing", "darwin")).toBe(join(local, "agy"));
  });

  it("starts a fake binary beneath script's PTY and terminates only its owned process", () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, kill: vi.fn(() => true) });
    const spawn = vi.fn(() => child);
    const supervisor = new AgyKeepaliveSupervisor({ binary: "/tmp/fake agy", platform: "darwin", spawn: spawn as never });
    supervisor.start();
    expect(spawn).toHaveBeenCalledWith("/usr/bin/script", ["-q", "/dev/null", "/tmp/fake agy"], expect.objectContaining({ stdio: "ignore" }));
    const environment = (spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(environment.HEADROOM_ROUTING).toBeUndefined();
    expect(environment.HTTP_PROXY).toBeUndefined();
    expect(environment.PATH).toBe(process.env.PATH);
    expect(supervisor.running).toBe(true);
    supervisor.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.running).toBe(false);
  });

  it("quotes a quote and a semicolon so the Linux script -qefc command cannot break out", () => {
    const malicious = "echo pwned; touch /tmp/headroom-shellquote-poc; exit 3'; echo also-pwned #";
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, kill: vi.fn(() => true) });
    const spawn = vi.fn(() => child);
    const supervisor = new AgyKeepaliveSupervisor({ binary: malicious, platform: "linux", spawn: spawn as never });
    supervisor.start();
    const args = (spawn.mock.calls[0] as unknown as [string, string[], unknown])[1];
    expect(args[0]).toBe("-qefc");
    const quoted = args[1];
    expect(quoted).not.toBe(malicious);
    // `script -qefc <command>` on Linux hands <command> to a shell verbatim.
    // Feeding the quoted token through a real shell here proves the embedded
    // quote and semicolons stay literal instead of ending the quoted string
    // and starting a second, attacker-controlled command.
    let exitCode = 0;
    try { execFileSync("/bin/sh", ["-c", quoted], { stdio: "pipe" }); }
    catch (error) { exitCode = (error as { status?: number }).status ?? -1; }
    expect(exitCode).not.toBe(3); // exit 3 would mean the injected "exit 3" ran on its own
    supervisor.stop();
  });

  it("restarts after its owned PTY exits with bounded backoff", () => {
    vi.useFakeTimers();
    const first = Object.assign(new EventEmitter(), { exitCode: null as number | null, kill: vi.fn(() => true) });
    const second = Object.assign(new EventEmitter(), { exitCode: null as number | null, kill: vi.fn(() => true) });
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) as never;
    const supervisor = new AgyKeepaliveSupervisor({ binary: "/tmp/fake-agy", platform: "darwin", spawn, restartDelay: () => 25 });
    try {
      supervisor.start();
      first.emit("exit", 1, null);
      vi.advanceTimersByTime(25);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(supervisor.running).toBe(true);
    } finally {
      supervisor.stop();
      vi.useRealTimers();
    }
  });

  it("reads login state from the newest fake agy log without inspecting credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-log-")); temporary.push(root);
    const old = join(root, "cli-old.log");
    const newest = join(root, "cli-new.log");
    await writeFile(join(root, "fake-agy"), "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(old, "applyAuthResult authMethod=consumer\n");
    await writeFile(newest, "error getting token source: You are not logged into Antigravity\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(newest, "error getting token source: You are not logged into Antigravity\n");
    await expect(agyLoginStateFromLog(root)).resolves.toBe("not_logged_in");
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, kill: vi.fn(() => true) });
    // logWatchMs bounds how long the supervisor keeps polling the log before
    // giving up; it has to comfortably outlast this whole test's two waitFor
    // steps on a loaded CI runner; a tight ~100ms budget (fine on a fast
    // local machine) was expiring mid-test on slower ubuntu/windows runners,
    // freezing loginState at "not_logged_in" and timing out the second wait.
    const supervisor = new AgyKeepaliveSupervisor({ binary: join(root, "fake-agy"), platform: "darwin", spawn: vi.fn(() => child) as never, logDirectory: root, logPollIntervalMs: 5, logWatchMs: 10_000 });
    try {
      supervisor.start();
      await vi.waitFor(() => expect(supervisor.loginState).toBe("not_logged_in"), { timeout: 5_000, interval: 10 });
      await writeFile(newest, "applyAuthResult authMethod=consumer\n");
      await vi.waitFor(() => expect(supervisor.loginState).toBe("logged_in"), { timeout: 5_000, interval: 10 });
    } finally { supervisor.stop(); }
  }, 15_000); // default 5s per-test timeout is too tight for two sequential 5s waitFor()s on a loaded CI runner

  it("reads only a bounded tail of a growing log, never the whole file", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-log-tail-")); temporary.push(root);
    const path = join(root, "cli-big.log");
    // A marker placed only in the first megabyte (well past the 64 KiB tail
    // this function is allowed to read) must never be found.
    const early = `applyAuthResult authMethod=consumer\n${"x".repeat(200_000)}`;
    const late = `\n${"y".repeat(200_000)}\nerror getting token source: You are not logged into Antigravity\n`;
    await writeFile(path, early + late);
    // The "not logged in" marker sits in the tail and is found; the earlier
    // "logged in" marker outside the tail is never seen, so the state comes
    // back not_logged_in rather than logged_in.
    await expect(agyLoginStateFromLog(root)).resolves.toBe("not_logged_in");
  });

  it("never follows a symlink in place of a real log file", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-agy-log-symlink-")); temporary.push(root);
    const real = join(root, "elsewhere.log");
    await writeFile(real, "applyAuthResult authMethod=consumer\n");
    const link = join(root, "cli-link.log");
    await symlink(real, link);
    // The only candidate is a symlink; it must be rejected rather than
    // followed, so no log is usable and the state stays unknown.
    await expect(agyLoginStateFromLog(root)).resolves.toBe("unknown");
  });

});
