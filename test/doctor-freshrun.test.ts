import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor, doctorChecks, isFreshInstall, nextSteps } from "../src/doctor.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

describe("nextSteps", () => {
  it("orders keychain grant, install-service, mcp add, gating keychain grant to macOS", () => {
    expect(nextSteps("darwin")).toEqual(["headroom keychain grant", "headroom install-service", "claude mcp add headroom -- npx headroomd mcp"]);
    expect(nextSteps("linux")).toEqual(["headroom install-service", "claude mcp add headroom -- npx headroomd mcp"]);
    expect(nextSteps("win32")).toEqual(["headroom install-service", "claude mcp add headroom -- npx headroomd mcp"]);
  });
});

describe("doctor first-run mode", () => {
  it("classifies a brand-new home (no daemon ever started) as fresh, and a home with a daemon log as not fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-fresh-")); temporary.push(root);
    await withHeadroomHome(join(root, ".headroom"), async () => {
      const checks = await doctorChecks();
      await expect(isFreshInstall(checks)).resolves.toBe(true);
    });

    const seasoned = await mkdtemp(join(tmpdir(), "headroom-doctor-seasoned-")); temporary.push(seasoned);
    const home = join(seasoned, ".headroom");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(join(home, "logs"), { recursive: true });
    await writeFile(join(home, "logs", "daemon.log"), "2026-09-03T12:00:00Z daemon started; listening on /tmp/x.sock\n", { mode: 0o644 });
    await withHeadroomHome(home, async () => {
      const checks = await doctorChecks();
      await expect(isFreshInstall(checks)).resolves.toBe(false);
    });
  });

  it("prints a Next steps block only on a fresh install, and never on a returning one", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-freshprint-")); temporary.push(root);
    const lines: string[] = [];
    const spy = (await import("vitest")).vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
    try {
      await withHeadroomHome(join(root, ".headroom"), async () => { await doctor(); });
    } finally { spy.mockRestore(); }
    expect(lines).toContain("Next steps:");
    expect(lines.some((line) => line.includes("headroom install-service"))).toBe(true);
    expect(lines.some((line) => line.includes("claude mcp add headroom"))).toBe(true);

    const seasoned = await mkdtemp(join(tmpdir(), "headroom-doctor-noprint-")); temporary.push(seasoned);
    const home = join(seasoned, ".headroom");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(join(home, "logs"), { recursive: true });
    await writeFile(join(home, "logs", "daemon.log"), "2026-09-03T12:00:00Z daemon started; listening on /tmp/x.sock\n", { mode: 0o644 });
    const lines2: string[] = [];
    const spy2 = (await import("vitest")).vi.spyOn(console, "log").mockImplementation((line: string) => { lines2.push(line); });
    try {
      await withHeadroomHome(home, async () => { await doctor(); });
    } finally { spy2.mockRestore(); }
    expect(lines2).not.toContain("Next steps:");
  });
});

describe("doctor severity: INFO for optional defaults, FAIL reserved for blocking reads", () => {
  it("reports missing policy.toml and routing.toml as INFO, not WARN", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-info-")); temporary.push(root);
    await withHeadroomHome(join(root, ".headroom"), async () => {
      const checks = await doctorChecks();
      const policy = checks.find((item) => item.check === "policy");
      const routing = checks.find((item) => item.check === "routing");
      expect(policy?.level).toBe("INFO");
      expect(routing?.level).toBe("INFO");
    });
  });

  it("reports an absent native engine as INFO, and an absent daemon as WARN (never FAIL: neither blocks a direct read)", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-info2-")); temporary.push(root);
    await withHeadroomHome(join(root, ".headroom"), async () => {
      const checks = await doctorChecks();
      const engineNative = checks.find((item) => item.check === "engine native hash");
      expect(engineNative?.level).toBe("INFO");
      const daemonSocket = checks.find((item) => item.check === "daemon socket");
      const daemonHealth = checks.find((item) => item.check === "daemon health");
      expect(daemonSocket).toMatchObject({ level: "WARN", detail: "not found" });
      expect(daemonHealth).toMatchObject({ level: "WARN" });
      expect(checks.every((item) => item.level !== "FAIL")).toBe(true);
    });
  });

  it("reports a never-created accounts.toml as WARN (no principal exists to block), distinct from a present-but-invalid file", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-principals-")); temporary.push(root);
    const home = join(root, ".headroom");
    await withHeadroomHome(home, async () => {
      const missing = await doctorChecks();
      expect(missing.find((item) => item.check === "principals")).toMatchObject({ level: "WARN" });
    });

    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "accounts.toml"), "not valid toml at all\n", { mode: 0o600 });
    await withHeadroomHome(home, async () => {
      const invalid = await doctorChecks();
      expect(invalid.find((item) => item.check === "principals")).toMatchObject({ level: "FAIL", detail: "accounts.toml is invalid" });
    });
  });
});
