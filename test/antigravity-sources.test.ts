import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agyLoginStateFromLog, AgyKeepaliveSupervisor, resolveAgyBinary } from "../src/antigravity-keepalive.js";
import { noDaemonObservations } from "../src/adapters/antigravity.js";
import { pollAccounts, selectAntigravitySource } from "../src/collector.js";
import type { Observation, ProviderAccount } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function row(meter: "gemini" | "claude-gpt", minutes: 300 | 10_080, source: string, freshness: Observation["freshness"] = "fresh"): Observation {
  return {
    principal_id: "antigravity", meter_id: "antigravity:" + meter, window: { kind: minutes === 300 ? "rolling" : "fixed", minutes, enforcement: "hard" },
    quantity: freshness === "fresh" ? { used: 16, limit: 100, remaining: 84, unit: "percent" } : null, resets_at: "2026-09-10T00:00:00Z",
    observed_at: "2026-09-03T00:00:00Z", fetched_at: "2026-09-03T00:00:00Z", source, truth: freshness === "fresh" ? "official" : "estimated",
    freshness, confidence: freshness === "fresh" ? 1 : 0, adapter_version: "test", upstream_schema_version: "test", ...(freshness === "fresh" ? {} : { reason: "quota summary not ready" }),
  };
}

describe("Antigravity source order", () => {
  it("uses the daemon-owned local source only once all four warm summary lanes are real", () => {
    const remote = [row("gemini", 300, "remote:antigravity"), row("gemini", 10_080, "remote:antigravity"), row("claude-gpt", 300, "remote:antigravity"), row("claude-gpt", 10_080, "remote:antigravity")];
    const warm = remote.map((item) => ({ ...item, source: "local:antigravity:warm", quantity: { used: 16, limit: 100, remaining: 84, unit: "percent" as const } }));
    expect(selectAntigravitySource(warm, remote, "antigravity")).toBe(warm);
    const cold = [...warm.slice(0, 2), row("claude-gpt", 10_080, "local:antigravity:warm", "failed")];
    expect(selectAntigravitySource(cold, remote, "antigravity")).toBe(remote);
  });
});

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
    const spawn = vi.fn(() => child) as never;
    const supervisor = new AgyKeepaliveSupervisor({ binary: "/tmp/fake agy", platform: "darwin", spawn });
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
    const spawn = vi.fn(() => child) as never;
    const supervisor = new AgyKeepaliveSupervisor({ binary: malicious, platform: "linux", spawn });
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
    const supervisor = new AgyKeepaliveSupervisor({ binary: join(root, "fake-agy"), platform: "darwin", spawn: vi.fn(() => child) as never, logDirectory: root, logPollIntervalMs: 5, logWatchMs: 100 });
    try {
      supervisor.start();
      await vi.waitFor(() => expect(supervisor.loginState).toBe("not_logged_in"));
      await writeFile(newest, "applyAuthResult authMethod=consumer\n");
      await vi.waitFor(() => expect(supervisor.loginState).toBe("logged_in"));
    } finally { supervisor.stop(); }
  });
});
