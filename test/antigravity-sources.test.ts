import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyKeepaliveSupervisor, resolveAgyBinary } from "../src/antigravity-keepalive.js";
import { selectAntigravitySource } from "../src/collector.js";
import type { Observation } from "../src/types.js";

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
    expect(supervisor.running).toBe(true);
    supervisor.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.running).toBe(false);
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
});
