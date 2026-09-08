import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { HeadroomStore } from "../src/store.js";

// Fake probe binaries (temporary shell scripts standing in for
// headroom-claude-probe) and HEADROOM_PROBE_PATH stand in for a real
// credential check here -- exactly the seam claude-probe-mapping.test.ts uses -- so this suite
// never touches a real Keychain item or a real probe binary.

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks(); });

// realpath'd immediately: a probe path this suite pins/prints is compared
// verbatim against what executablePath() resolves it to internally, and on
// macOS $TMPDIR itself sits behind a symlink (/var -> /private/var) that
// realpath silently canonicalizes -- without this, every exact-path
// assertion below would spuriously fail on macOS only.
async function realTmpDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return realpath(root);
}

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

async function withProbePath<T>(path: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_PROBE_PATH;
  if (path === undefined) delete process.env.HEADROOM_PROBE_PATH; else process.env.HEADROOM_PROBE_PATH = path;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_PROBE_PATH; else process.env.HEADROOM_PROBE_PATH = previous; }
}

/** A fake probe binary that reads successfully: exit 0, a JSON body small
 * enough to clear assertVendorResponseLimits (checkClaudeCredentialReadable never
 * inspects its shape, only that parsing succeeds). */
async function fakeGrantingProbe(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function seedAccounts(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, "accounts.toml"), ["[[accounts]]", 'name = "claude-main"', 'vendor = "claude"', 'location = "/nonexistent/.claude"', 'adapter = "native-ts"', ""].join("\n"), { mode: 0o600 });
}

async function captureConsole<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
  try { const result = await run(); return { result, logs, errors }; }
  finally { logSpy.mockRestore(); errorSpy.mockRestore(); }
}

describe.skipIf(process.platform === "win32")("headroom keychain grant: which probe binary actually gets granted", () => {
  it("with no pin yet, grants this CLI's own probe and pins the store to it, naming the granted binary", async () => {
    const root = await realTmpDir("headroom-grant-nopin-"); temporary.push(root);
    const home = join(root, ".headroom");
    await seedAccounts(home);
    const probe = await fakeGrantingProbe(root, "probe-fresh-grant");
    await withHeadroomHome(home, () => withProbePath(probe, async () => {
      const { result, logs } = await captureConsole(() => main(["keychain", "grant", "--principal", "claude-main"]));
      expect(result).toBe(0);
      expect(logs.join("\n")).toContain(`claude-main: credential readable, no dialog needed (probe: ${probe})`);
      const store = await HeadroomStore.open(home);
      try { expect(store.probePath()).toBe(probe); } finally { store.close(); }
    }));
  });

  it("with a pin that still resolves, grants exactly the pinned binary -- not whatever this CLI would otherwise pick", async () => {
    const root = await realTmpDir("headroom-grant-pinned-"); temporary.push(root);
    const home = join(root, ".headroom");
    await seedAccounts(home);
    const pinnedProbe = await fakeGrantingProbe(root, "probe-pinned");
    const seed = await HeadroomStore.open(home);
    seed.setProbePath(pinnedProbe);
    seed.close();
    // Deliberately no HEADROOM_PROBE_PATH override here: this is exactly the
    // scenario the incident describes, where the CLI process is a different
    // build from whatever was pinned. The pin alone must be enough.
    await withHeadroomHome(home, async () => {
      const { result, logs } = await captureConsole(() => main(["keychain", "grant", "--principal", "claude-main"]));
      expect(result).toBe(0);
      expect(logs.join("\n")).toContain(`claude-main: credential readable, no dialog needed (probe: ${pinnedProbe})`);
      const store = await HeadroomStore.open(home);
      try { expect(store.probePath()).toBe(pinnedProbe); } finally { store.close(); }
    });
  });

  it("refuses and names --use-this-build when the pinned binary no longer exists, without granting anything", async () => {
    const root = await realTmpDir("headroom-grant-stale-"); temporary.push(root);
    const home = join(root, ".headroom");
    await seedAccounts(home);
    const staleProbe = join(root, "probe-deleted-checkout-build");
    const seed = await HeadroomStore.open(home);
    seed.setProbePath(staleProbe);
    seed.close();
    const cliProbe = await fakeGrantingProbe(root, "probe-cli-own-build");
    await withHeadroomHome(home, () => withProbePath(cliProbe, async () => {
      const { result, logs, errors } = await captureConsole(() => main(["keychain", "grant", "--principal", "claude-main"]));
      expect(result).toBe(1);
      const text = [...logs, ...errors].join("\n");
      expect(text).toContain(staleProbe);
      expect(text).toContain("no longer exists");
      expect(text).toContain("--use-this-build");
      expect(text).toContain(cliProbe);
      expect(text).not.toContain("credential readable, no dialog needed");
      const store = await HeadroomStore.open(home);
      try { expect(store.probePath()).toBe(staleProbe); } finally { store.close(); } // unchanged
    }));
  });

  it("with --use-this-build, grants this CLI's own probe and re-pins the store to it", async () => {
    const root = await realTmpDir("headroom-grant-usebuild-"); temporary.push(root);
    const home = join(root, ".headroom");
    await seedAccounts(home);
    const staleProbe = join(root, "probe-deleted-checkout-build");
    const seed = await HeadroomStore.open(home);
    seed.setProbePath(staleProbe);
    seed.close();
    const cliProbe = await fakeGrantingProbe(root, "probe-cli-own-build-2");
    await withHeadroomHome(home, () => withProbePath(cliProbe, async () => {
      const { result, logs } = await captureConsole(() => main(["keychain", "grant", "--principal", "claude-main", "--use-this-build"]));
      expect(result).toBe(0);
      expect(logs.join("\n")).toContain(`claude-main: credential readable, no dialog needed (probe: ${cliProbe})`);
      const store = await HeadroomStore.open(home);
      try { expect(store.probePath()).toBe(cliProbe); } finally { store.close(); } // re-pinned
    }));
  });
});
