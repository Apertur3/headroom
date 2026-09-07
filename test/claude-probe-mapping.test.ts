import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProbeError, claudeKeychainMetadata, grantClaudeKeychainAccess, KEYCHAIN_INTERACTION_BLOCKED_MESSAGE } from "../src/adapters/claude.js";
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

async function fakeSecurity(root: string, script: string): Promise<void> {
  const path = join(root, "security");
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function withFakeSecurityOnPath<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  // Prepended, not replaced: execFile resolves the bare command "security"
  // through PATH, so this fake must be found before the real /usr/bin/security.
  process.env.PATH = `${dir}${delimiter}${previous ?? ""}`;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
}

// claudeKeychainMetadata() itself is platform-agnostic (the darwin gate lives
// in observeClaude's caller), but a real `security` binary only exists on
// macOS, and a shell-script fake is not meaningfully executable through
// execFile on Windows either -- exercised on POSIX runners only, like every
// other fake-executable test in this file.
describe.skipIf(process.platform === "win32")("claudeKeychainMetadata: fake `security` command substituted via PATH, never the real login Keychain", () => {
  it("found=true with a parsed mdat, from a fake item that exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-fake-security-found-")); temporary.push(root);
    await fakeSecurity(root, [
      "#!/bin/sh",
      "cat <<'HRM_EOF'",
      'keychain: "/x/login.keychain-db"',
      "version: 512",
      'class: "genp"',
      "attributes:",
      '    "mdat"<timedate>=0x32303236303930373035323434335A00  "20260907052443Z\\000"',
      "HRM_EOF",
      "",
    ].join("\n"));
    await withFakeSecurityOnPath(root, async () => {
      const metadata = await claudeKeychainMetadata("Claude Code-credentials-test");
      expect(metadata.found).toBe(true);
      expect(metadata.modifiedAt?.toISOString()).toBe("2026-09-07T05:24:43.000Z");
    });
  });

  it("found=false on the real `security` tool's own 'could not be found' exit (44), the genuinely-absent-login case", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-fake-security-missing-")); temporary.push(root);
    await fakeSecurity(root, [
      "#!/bin/sh",
      'echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." 1>&2',
      "exit 44",
      "",
    ].join("\n"));
    await withFakeSecurityOnPath(root, async () => {
      await expect(claudeKeychainMetadata("nonexistent")).resolves.toEqual({ found: false });
    });
  });

  it("found=false rather than throwing when the command fails in some other, unexpected way", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-fake-security-error-")); temporary.push(root);
    await fakeSecurity(root, ["#!/bin/sh", "exit 1", ""].join("\n"));
    await withFakeSecurityOnPath(root, async () => {
      await expect(claudeKeychainMetadata("whatever")).resolves.toEqual({ found: false });
    });
  });

  it("never passes -w: the argument vector never asks for the secret itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-fake-security-argv-")); temporary.push(root);
    const capture = join(root, "argv.txt");
    await fakeSecurity(root, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${capture}`,
      "exit 44",
      "",
    ].join("\n"));
    await withFakeSecurityOnPath(root, async () => {
      await claudeKeychainMetadata("Claude Code-credentials");
      const { readFile } = await import("node:fs/promises");
      const argv = (await readFile(capture, "utf8")).trim().split("\n");
      expect(argv).toEqual(["find-generic-password", "-s", "Claude Code-credentials"]);
    });
  });
});
