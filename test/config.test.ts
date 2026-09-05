import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRouting, seedExampleConfig } from "../src/config.js";
import { defaultAntigravityKeepalive, parsePolicy } from "../src/policy.js";

describe("policy defaults", () => {
  it("keeps Antigravity alive when the key is absent on macOS and Linux", () => {
    const policy = parsePolicy("poll_interval_minutes = 5\n");
    expect(policy.antigravity_keepalive).toBe(defaultAntigravityKeepalive());
    expect(defaultAntigravityKeepalive("darwin")).toBe(true);
    expect(defaultAntigravityKeepalive("linux")).toBe(true);
    expect(defaultAntigravityKeepalive("win32")).toBe(false);
  });

  it("defaults pacing to even, and parses an explicit pacing = \"none\"", () => {
    expect(parsePolicy("poll_interval_minutes = 5\n").pacing).toBe("even");
    expect(parsePolicy('pacing = "even"\n').pacing).toBe("even");
    expect(parsePolicy('pacing = "none"\n').pacing).toBe("none");
  });
});

describe("seedExampleConfig", () => {
  const temporary: string[] = [];
  afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  it("copies policy.toml and routing.toml from examples/ into a fresh home, naming the seeded action classes", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-seed-"));
    temporary.push(home);
    const messages = await seedExampleConfig(home);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(`Seeded ${join(home, "policy.toml")} from examples/policy.toml.`);
    expect(messages[1]).toContain(`Seeded ${join(home, "routing.toml")} from examples/routing.toml`);
    expect(messages[1]).toContain("claude-fable");
    expect(messages[1]).toContain("codex-build");
    expect(messages[1]).toContain("gemini-bulk");

    const policyText = await readFile(join(home, "policy.toml"), "utf8");
    expect(policyText).toContain("freeze_reserve_pct");
    const routingText = await readFile(join(home, "routing.toml"), "utf8");
    expect(Object.keys(parseRouting(routingText).consumes)).toEqual(["claude-fable", "codex-build", "gemini-bulk"]);

    if (process.platform === "win32") {
      // Windows has no POSIX permission bits (seedExampleConfig's writeFile
      // mode: 0o600 is a harmless no-op there); there is nothing meaningful
      // to assert about the file's mode on this platform.
      console.log("SKIP policy.toml mode assertion on win32: no POSIX permission bits to check");
    } else {
      const policyStat = await stat(join(home, "policy.toml"));
      expect(policyStat.mode & 0o777).toBe(0o600);
    }
  });

  it("never overwrites an existing policy.toml or routing.toml, and reports nothing for files already present", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-seed-existing-"));
    temporary.push(home);
    await writeFile(join(home, "policy.toml"), "poll_interval_minutes = 9\n", { mode: 0o600 });
    await writeFile(join(home, "routing.toml"), '[consumes]\nmine = ["x:y"]\n', { mode: 0o600 });
    const messages = await seedExampleConfig(home);
    expect(messages).toEqual([]);
    expect(await readFile(join(home, "policy.toml"), "utf8")).toContain("poll_interval_minutes = 9");
    expect(await readFile(join(home, "routing.toml"), "utf8")).toContain("mine");
  });

  it("seeds only the missing one when the other is already present", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-seed-partial-"));
    temporary.push(home);
    await writeFile(join(home, "policy.toml"), "poll_interval_minutes = 9\n", { mode: 0o600 });
    const messages = await seedExampleConfig(home);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("routing.toml");
    expect(await readFile(join(home, "policy.toml"), "utf8")).toContain("poll_interval_minutes = 9");
  });
});
