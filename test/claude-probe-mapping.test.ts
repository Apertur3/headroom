import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProbeError, grantClaudeKeychainAccess, KEYCHAIN_INTERACTION_BLOCKED_MESSAGE } from "../src/adapters/claude.js";
import { main } from "../src/cli.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function fakeProbe(root: string, name: string, marker: string, exitCode: number): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\necho ${marker} 1>&2\nexit ${exitCode}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function withProbePath<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_PROBE_PATH;
  process.env.HEADROOM_PROBE_PATH = path;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_PROBE_PATH; else process.env.HEADROOM_PROBE_PATH = previous; }
}

// The probe binary is macOS-only in real use (Keychain access); this table
// tests the TypeScript side's exit-code/stderr marker mapping via a fake
// executable substituted through HEADROOM_PROBE_PATH, a shell script that is
// not meaningfully executable through execFile on Windows -- exercised on
// POSIX runners only, same as every other real invocation of this probe.
describe.skipIf(process.platform === "win32")("claude probe: fake exit-code/marker mapping", () => {
  it("errSecInteractionNotAllowed / a cancelled interaction -> 'the Keychain dialog cannot be shown from this shell', never 'no login'", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-mapping-")); temporary.push(root);
    const probe = await fakeProbe(root, "probe-interaction-not-allowed", "HEADROOM_PROBE_INTERACTION_NOT_ALLOWED", 3);
    await withProbePath(probe, async () => {
      await expect(grantClaudeKeychainAccess("/nonexistent/.claude")).rejects.toMatchObject({ kind: "no_interaction", message: KEYCHAIN_INTERACTION_BLOCKED_MESSAGE });
    });
  });

  it("errSecAuthFailed (a real ACL denial) -> the existing 'Keychain access denied' kind, distinct from interaction-not-allowed", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-mapping-")); temporary.push(root);
    const probe = await fakeProbe(root, "probe-denied", "HEADROOM_PROBE_KEYCHAIN_DENIED", 3);
    await withProbePath(probe, async () => {
      await expect(grantClaudeKeychainAccess("/nonexistent/.claude")).rejects.toMatchObject({ kind: "denied", message: "Keychain access denied" });
    });
  });

  it("errSecItemNotFound (no exit code marker at all: a genuinely absent login) -> 'no credentials in Keychain for this config dir', never the interaction wording", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-mapping-")); temporary.push(root);
    // The real probe's own catch-all: no marker printed, a bare nonzero exit.
    const probe = await fakeProbe(root, "probe-not-found", "", 1);
    await withProbePath(probe, async () => {
      const error = await grantClaudeKeychainAccess("/nonexistent/.claude").catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ClaudeProbeError);
      expect((error as ClaudeProbeError).kind).toBe("missing");
      expect((error as ClaudeProbeError).message).toBe("no credentials in Keychain for this config dir");
    });
  });

  it("a timeout marker still maps to the existing 'timeout' kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-probe-mapping-")); temporary.push(root);
    const probe = await fakeProbe(root, "probe-timeout", "HEADROOM_PROBE_TIMEOUT", 4);
    await withProbePath(probe, async () => {
      await expect(grantClaudeKeychainAccess("/nonexistent/.claude")).rejects.toMatchObject({ kind: "timeout" });
    });
  });
});

describe.skipIf(process.platform === "win32")("headroom keychain grant: prints the interaction-blocked message, not 'no login'", () => {
  it("via a fake probe substituted through HEADROOM_PROBE_PATH -- never touches a real Keychain item", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-keychain-grant-cli-")); temporary.push(root);
    const home = join(root, ".headroom");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/nonexistent/.claude"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
    const probe = await fakeProbe(root, "probe-interaction-not-allowed-cli", "HEADROOM_PROBE_INTERACTION_NOT_ALLOWED", 3);
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
    try {
      await withHeadroomHome(home, () => withProbePath(probe, async () => {
        const code = await main(["keychain", "grant", "--principal", "claude-main"]);
        expect(code).toBe(1); // a failure to grant, not a crash
      }));
    } finally { logSpy.mockRestore(); errorSpy.mockRestore(); }
    const text = [...logs, ...errors].join("\n");
    expect(text).toContain(KEYCHAIN_INTERACTION_BLOCKED_MESSAGE);
    expect(text).not.toContain("no Claude login for");
  });
});
