import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterCheck, antigravityOrphanCheck, doctorChecks, doctorFileStatus, homeCheck, hostPressureCheck } from "../src/doctor.js";
import { socketPath } from "../src/daemon.js";
import { defaultHostGuardPolicy, type HostGuardPolicy, type HostHealth } from "../src/host-health.js";
import type { ProcessEntry } from "../src/process-tree.js";
import { HeadroomStore } from "../src/store.js";

const temporary: string[] = [];

it.skipIf(process.platform === "win32")("doctor reports an overlong socket path without losing the remaining diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-doctor-")); temporary.push(root);
  const home = join(root, "a".repeat(110));
  let message = "";
  try { socketPath(home); } catch (error) { message = (error as Error).message; }
  vi.stubEnv("HEADROOM_HOME", home);
  try {
    const checks = await doctorChecks();
    expect(message).toContain("Set HEADROOM_HOME to a shorter directory.");
    expect(checks).toContainEqual(expect.objectContaining({ check: "daemon socket", level: "FAIL", detail: message, fix: "set HEADROOM_HOME to a shorter directory" }));
    expect(checks.some((item) => item.check === "daemon log")).toBe(true);
  } finally { vi.unstubAllEnvs(); }
});
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("doctor file checks", () => {
  it("accepts normal 0644 config files and service-created logs instead of calling them absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-")); temporary.push(root);
    const file = join(root, "policy.toml");
    await writeFile(file, "poll_interval_minutes = 5\n", { mode: 0o644 });
    await chmod(file, 0o644);
    await expect(doctorFileStatus(file)).resolves.toBe("present");
    await expect(doctorFileStatus(join(root, "missing.log"))).resolves.toBe("missing");
  });
});

describe("doctor adapter check", () => {
  it("warns that codexbar performs its own network calls outside the outbound allowlist", () => {
    const result = adapterCheck({ name: "codex-main", vendor: "codex", location: "/nonexistent/.codex", adapter: "codexbar" });
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain("performs its own network calls outside Headroom's outbound allowlist");
    expect(result.detail).toContain("truth: estimated");
  });

  it("does not warn for a native-ts adapter", () => {
    const result = adapterCheck({ name: "codex-main", vendor: "codex", location: "/nonexistent/.codex", adapter: "native-ts" });
    expect(result.level).toBe("OK");
    expect(result.detail).not.toContain("outbound allowlist");
  });
});

describe.skipIf(process.platform === "win32")("doctor: orphaned antigravity keepalive agy processes (issue #56)", () => {
  it("warns with a count, total resident memory, and a kill-by-pid hint for agy processes reparented to init", async () => {
    const list = async (): Promise<ProcessEntry[]> => [
      { pid: 111, ppid: 1, rssKb: 150_000, command: "/Users/test/.local/bin/agy" },
      { pid: 222, ppid: 1, rssKb: 10_000, command: "/Users/test/.local/bin/agy" },
      { pid: 333, ppid: 555, rssKb: 999_999, command: "/Users/test/.local/bin/agy" }, // has a live parent -- not orphaned
      { pid: 444, ppid: 1, rssKb: 500_000, command: "/usr/bin/something-else" }, // orphaned, but not agy
    ];
    const result = await antigravityOrphanCheck(list);
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain("2 orphaned agy process(es)");
    expect(result.detail).toContain("156 MB"); // (150000 + 10000) KB / 1024, rounded
    expect(result.fix).toContain("111");
    expect(result.fix).toContain("222");
    expect(result.fix).not.toContain("333");
    expect(result.fix).not.toContain("444");
  });

  it("matches an agy binary on Windows-style paths and with a .exe suffix too", async () => {
    const result = await antigravityOrphanCheck(async () => [{ pid: 9, ppid: 1, rssKb: 1_000, command: "C:\\Users\\test\\agy.exe" }]);
    expect(result.level).toBe("WARN");
    expect(result.fix).toContain("9");
  });

  it("reports OK when nothing is orphaned", async () => {
    const result = await antigravityOrphanCheck(async () => []);
    expect(result.level).toBe("OK");
    expect(result.detail).toBe("no orphaned agy processes found");
  });

  it("never flags an unrelated process whose path merely contains 'agy' as a substring", async () => {
    const result = await antigravityOrphanCheck(async () => [{ pid: 1, ppid: 1, rssKb: 1_000, command: "/usr/bin/agyration-something-else" }]);
    expect(result.level).toBe("OK");
  });

  it("never counts a user's own orphaned `script` session as a leaked agy", async () => {
    const result = await antigravityOrphanCheck(async () => [{ pid: 77, ppid: 1, rssKb: 2_000, command: "/usr/bin/script" }]);
    expect(result.level).toBe("OK");
  });
});

describe("doctor: host pressure check", () => {
  const health = (overrides: Partial<HostHealth> = {}): HostHealth => ({
    state: "ok", reasons: [], load_ratio: 0.1, pty_used: 1, pty_max: 100, orphans: 0, ...overrides,
  });

  it("reports FAIL for a refuse reading", async () => {
    const result = await hostPressureCheck(
      async () => health({ state: "refuse", reasons: ["load_ratio 4.00 exceeds host_guard.refuse_load_ratio (3)"] }),
      defaultHostGuardPolicy,
    );
    expect(result.check).toBe("host pressure");
    expect(result.level).toBe("FAIL");
    expect(result.detail).toContain("refuse");
    expect(result.detail).toContain("load_ratio 4.00 exceeds host_guard.refuse_load_ratio (3)");
    expect(result.fix).toContain("headroom run currently refuses");
  });

  it("reports WARN for a warn reading", async () => {
    const result = await hostPressureCheck(async () => health({ state: "warn", reasons: ["1 orphaned agy process(es) found"] }), defaultHostGuardPolicy);
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain("warn");
  });

  it("reports OK for an ok reading, and INFO for unknown", async () => {
    const ok = await hostPressureCheck(async () => health(), defaultHostGuardPolicy);
    expect(ok.level).toBe("OK");
    const unknown = await hostPressureCheck(async () => health({ state: "unknown", reasons: ["no host pressure measurements available on this platform"], load_ratio: null, pty_used: null, pty_max: null, orphans: null }), defaultHostGuardPolicy);
    expect(unknown.level).toBe("INFO");
    expect(unknown.fix).toContain("no host pressure probe is available");
  });

  it("names the configured mode in its detail line", async () => {
    const warnMode: HostGuardPolicy = { ...defaultHostGuardPolicy, mode: "warn" };
    const result = await hostPressureCheck(async () => health({ state: "refuse", reasons: ["x"] }), warnMode);
    expect(result.detail).toContain("mode: warn");
  });
});

describe("doctor: home directory permission check", () => {
  it.skipIf(process.platform === "win32")("names the actual directory in chmod 700 fix for 0755 home", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-home-custom-")); temporary.push(root);
    const home = join(root, "custom-headroom");
    await mkdir(home, { recursive: true, mode: 0o755 });
    await chmod(home, 0o755);
    const { check, store } = await homeCheck(home);
    expect(check.level).toBe("FAIL");
    expect(check.fix).toBe(`chmod 700 ${home}`);
    expect(store).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("quotes the home path if it contains spaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-home-space-")); temporary.push(root);
    const home = join(root, "custom headroom");
    await mkdir(home, { recursive: true, mode: 0o755 });
    await chmod(home, 0o755);
    const { check, store } = await homeCheck(home);
    expect(check.level).toBe("FAIL");
    expect(check.fix).toBe(`chmod 700 "${home}"`);
    expect(store).toBeUndefined();
  });

  it("names the actual home path in chmod 700 fix when store rejects group/world permissions", async () => {
    const spy = vi.spyOn(HeadroomStore, "open").mockRejectedValueOnce(
      new Error("Refusing ~/.headroom with group or world permissions; run: chmod 700 ~/.headroom")
    );
    try {
      const { check, store } = await homeCheck("/var/headroom/custom");
      expect(check.level).toBe("FAIL");
      expect(check.fix).toBe("chmod 700 /var/headroom/custom");
      expect(store).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("quotes the actual home path in chmod 700 fix when path contains spaces", async () => {
    const spy = vi.spyOn(HeadroomStore, "open").mockRejectedValueOnce(
      new Error("Refusing ~/.headroom with group or world permissions; run: chmod 700 ~/.headroom")
    );
    try {
      const { check, store } = await homeCheck("/var/headroom/custom home");
      expect(check.level).toBe("FAIL");
      expect(check.fix).toBe('chmod 700 "/var/headroom/custom home"');
      expect(store).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
