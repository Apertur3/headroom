import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapterCheck, antigravityOrphanCheck, doctorFileStatus } from "../src/doctor.js";
import type { ProcessEntry } from "../src/process-tree.js";

const temporary: string[] = [];
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
});
