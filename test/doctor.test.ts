import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapterCheck, doctorFileStatus } from "../src/doctor.js";

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
