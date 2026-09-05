import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { claudeGrantNeededReason } from "../src/adapters/claude.js";
import { pollAccounts } from "../src/collector.js";
import { isMainModule as cliIsMainModule } from "../src/cli.js";
import { doctorChecks, homeCheck, keychainGrantCheck } from "../src/doctor.js";
import { credentialPath } from "../src/paths.js";
import { HeadroomStore } from "../src/store.js";
import { isMainModule, supportsBuiltinSqlite, warningSuppressionFlag } from "../bin/headroom.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

describe("collector gate for a Claude principal awaiting a Keychain grant", () => {
  it("never attempts the probe for a gated principal, returning the synthetic grant-needed observations instead", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-collector-gate-")); temporary.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "accounts.toml"), [
      "[[accounts]]",
      'name = "claude-main"',
      'vendor = "claude"',
      'location = "/nonexistent/.claude"',
      'adapter = "native-ts"',
      "",
    ].join("\n"), { mode: 0o600 });
    await withHeadroomHome(root, async () => {
      const result = await pollAccounts(undefined, { claudeGrant: { needsGrant: () => true, markGrantNeeded: () => { throw new Error("must not be called: the probe was never attempted"); }, markProbeSucceeded: () => { throw new Error("must not be called: the probe was never attempted"); } } });
      const claudeRows = result.observations.filter((item) => item.principal_id === "claude-main");
      expect(claudeRows).toHaveLength(3);
      expect(claudeRows.every((item) => item.freshness === "failed" && item.reason === claudeGrantNeededReason("claude-main"))).toBe(true);
      // Never "Claude probe not built" (which only fires if claudeProbe() actually ran)
      // or any other message: the gate short-circuits before observeClaude is called.
      expect(claudeRows.every((item) => item.source === "native:claude")).toBe(true);
    });
  });

  // The "gate open" half (a real denial marking the store via
  // markGrantNeeded) is intentionally not exercised end-to-end here: with the
  // gate open, pollAccounts calls the real observeClaude(), which on macOS
  // resolves and runs the actual signed Keychain probe binary -- exactly the
  // live credential access this test suite must never trigger. That mapping
  // (a denied/timed-out probe producing the same claudeGrantNeededReason
  // text the collector matches on) is covered at the adapter level in
  // native-adapters.test.ts, via observeClaude's injectable `probe` seam.
});

describe("doctor home directory and keychain grant checks", () => {
  it("creates a fresh Headroom home at 0700 and reports OK", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-home-fresh-")); temporary.push(root);
    const home = join(root, ".headroom");
    const { check, store } = await homeCheck(home);
    expect(check).toMatchObject({ level: "OK", check: "home directory" });
    store?.close();
    const stat = await lstat(home);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("reports FAIL with the chmod fix for a pre-existing 0755 home", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-home-0755-")); temporary.push(root);
    const home = join(root, ".headroom");
    await mkdir(home, { recursive: true, mode: 0o755 });
    await chmod(home, 0o755); // belt and suspenders: mkdir's mode is umask-masked too
    const { check, store } = await homeCheck(home);
    expect(check.level).toBe("FAIL");
    expect(check.detail).toContain("run: chmod 700 ~/.headroom");
    expect(check.fix).toBe("chmod 700 ~/.headroom");
    expect(store).toBeUndefined();
  });

  it("flags a Claude principal with a pending marker, and only Claude principals", () => {
    const claude = { name: "claude-main", vendor: "claude", location: "/x", adapter: "native-ts" } as const;
    const codex = { name: "codex-main", vendor: "codex", location: "/x", adapter: "native-ts" } as const;
    expect(keychainGrantCheck(claude, new Map())).toBeUndefined();
    const grants = new Map([["claude-main", "Keychain access denied"]]);
    expect(keychainGrantCheck(claude, grants)).toMatchObject({
      level: "FAIL",
      check: "principal claude-main keychain grant",
      detail: "Keychain grant needed; run: headroom keychain grant --principal claude-main",
      fix: "headroom keychain grant --principal claude-main",
    });
    expect(keychainGrantCheck(codex, new Map([["codex-main", "irrelevant"]]))).toBeUndefined();
  });

  it("accepts a 0755 HOME with a nested 0700 HEADROOM_HOME, the exact scripts/smoke-cold.sh shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-home-cold-")); temporary.push(root);
    const userHome = join(root, "home");
    const headroomHomePath = join(userHome, ".headroom");
    await mkdir(userHome, { recursive: true, mode: 0o755 });
    await chmod(userHome, 0o755); // belt and suspenders: mkdir's mode is umask-masked too
    await mkdir(headroomHomePath, { recursive: true, mode: 0o700 });
    const { check, store } = await homeCheck(headroomHomePath);
    expect(check).toMatchObject({ level: "OK", check: "home directory", detail: headroomHomePath });
    store?.close();
  });

  it("uses the resolved HEADROOM_HOME, never $HOME/.headroom, when HEADROOM_HOME points elsewhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-home-override-")); temporary.push(root);
    const userHome = join(root, "home"); // $HOME/.headroom would resolve here -- and must never be touched
    const actual = join(root, "elsewhere", ".headroom"); // HEADROOM_HOME points here instead
    await mkdir(userHome, { recursive: true, mode: 0o755 });
    await withHeadroomHome(actual, async () => {
      const checks = await doctorChecks();
      const home = checks.find((item) => item.check === "home directory");
      expect(home).toMatchObject({ level: "OK", detail: actual });
      await expect(lstat(join(userHome, ".headroom"))).rejects.toThrow(); // never created under $HOME
    });
  });

  it("skips the Keychain probe for a gated Claude principal and audits the skip, not a call", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-gated-")); temporary.push(root);
    const home = join(root, ".headroom");
    await withHeadroomHome(home, async () => {
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(join(home, "accounts.toml"), [
        "[[accounts]]",
        'name = "claude-main"',
        'vendor = "claude"',
        'location = "/nonexistent/.claude"',
        'adapter = "native-ts"',
        "",
      ].join("\n"), { mode: 0o600 });
      const seed = await HeadroomStore.open(home);
      seed.setKeychainGrantNeeded("claude-main", "Keychain access denied");
      seed.close();
      const checks = await doctorChecks();
      const credential = checks.find((item) => item.check === "principal claude-main credential");
      const store = await HeadroomStore.open(home);
      try {
        const db = (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } } }).db;
        const rows = db.prepare("SELECT * FROM audit WHERE action = 'claude_probe' AND caller = 'doctor'").all();
        if (process.platform === "darwin") {
          // Distinct from the real "Claude Keychain item is unavailable" message
          // credentialCheck's own security(1) call would otherwise produce; this
          // text only appears on the gated, no-Keychain-touch path.
          expect(credential).toMatchObject({ level: "FAIL", detail: "Keychain grant needed; probe skipped" });
          expect(rows).toEqual([expect.objectContaining({ meter_or_principal: "claude-main", outcome: "skipped: grant needed" })]);
        } else {
          // The Keychain-gated path only exists on macOS, where Claude's
          // credentials actually live in the Keychain; credentialCheck's
          // grant-marker gate is guarded by `process.platform === "darwin"`
          // (src/doctor.ts) for exactly that reason. Elsewhere it reads the
          // plain credential file directly, ignoring the marker set above,
          // so there is nothing to skip and no claude_probe audit row at all.
          const path = credentialPath("claude", "/nonexistent/.claude");
          expect(credential).toMatchObject({ level: "FAIL", detail: `missing or unsafe credential file (${path})` });
          expect(rows).toEqual([]);
        }
      } finally { store.close(); }
    });
  });

  it("reports the engine upstream hash as INFO (not WARN) on a fresh install, with the optional wording", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-engine-")); temporary.push(root);
    await withHeadroomHome(join(root, ".headroom"), async () => {
      const checks = await doctorChecks();
      const home = checks.find((item) => item.check === "home directory");
      expect(home).toMatchObject({ level: "OK" });
      const upstream = checks.find((item) => item.check === "engine upstream hash");
      expect(upstream?.level).toBe("INFO");
      expect(upstream?.detail).toContain("optional, needed only for providers without a native adapter");
    });
  });
});

describe("bin/headroom.js launcher flags", () => {
  it("requires the Node version that ships node:sqlite unflagged", () => {
    expect(supportsBuiltinSqlite("22.13.0")).toBe(true);
    expect(supportsBuiltinSqlite("22.12.9")).toBe(false);
    expect(supportsBuiltinSqlite("23.4.0")).toBe(true);
    expect(supportsBuiltinSqlite("23.3.9")).toBe(false);
    expect(supportsBuiltinSqlite("24.0.0")).toBe(true);
  });

  it("silences only the ExperimentalWarning type on every Node version this launcher runs on", () => {
    expect(warningSuppressionFlag("22.13.0")).toBe("--disable-warning=ExperimentalWarning");
    expect(warningSuppressionFlag("23.4.0")).toBe("--disable-warning=ExperimentalWarning");
    expect(warningSuppressionFlag("24.0.0")).toBe("--disable-warning=ExperimentalWarning");
    // Defensive fallback only; the launcher's own version gate never lets a
    // Node this old actually reach this call.
    expect(warningSuppressionFlag("18.0.0")).toBe("--no-warnings=ExperimentalWarning");
  });

  it("still recognizes itself as the entry module when invoked through a symlinked path", async () => {
    // Regression for the packed-CLI "prints nothing, exit 0" bug: on macOS,
    // TMPDIR (and any npm global prefix under it) crosses a system symlink
    // (/var -> /private/var). import.meta.url is always the resolved, real
    // path; a literal argv[1] string compare then never matches and main()
    // silently never runs. isMainModule resolves argv[1] the same way first.
    const root = await mkdtemp(join(tmpdir(), "headroom-mainmodule-")); temporary.push(root);
    const real = join(root, "real");
    await mkdir(real);
    const target = join(real, "headroom.js");
    await writeFile(target, "");
    const link = join(root, "link");
    const { symlink } = await import("node:fs/promises");
    await symlink(real, link);
    const throughSymlink = join(link, "headroom.js");
    // import.meta.url is always the realpath-resolved URL, even for a target
    // reached without any symlink in the literal argument (the mktemp root
    // itself may sit under a symlinked TMPDIR, e.g. macOS's /var alias).
    const { realpath } = await import("node:fs/promises");
    const metaUrl = pathToFileURL(await realpath(target)).href;
    expect(isMainModule(metaUrl, throughSymlink)).toBe(true);
    expect(cliIsMainModule(metaUrl, throughSymlink)).toBe(true);
    expect(isMainModule(metaUrl, undefined)).toBe(false);
    expect(isMainModule(metaUrl, join(root, "nonexistent.js"))).toBe(false);
    expect(isMainModule(metaUrl, join(root, "other.js"))).toBe(false);
  });
});
