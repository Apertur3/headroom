import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const realScript = join(__dirname, "..", "scripts", "build-probe.sh");

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/**
 * A self-contained fake repo: the real build-probe.sh script (copied
 * verbatim), a throwaway engine/ source tree, and a fakebin/ directory put
 * first on PATH so `swift`, `codesign`, and `security` never touch a real
 * Swift toolchain, a real signature, or the real login keychain. Every test
 * below runs the REAL script logic (hash computation, the skip decision,
 * identity resolution, the fallback path) against these fakes -- nothing
 * here is a reimplementation of the script's own behavior.
 */
async function fakeRepo(): Promise<{ root: string; log: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), "headroom-build-probe-")); temporary.push(root);
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(realScript, join(root, "scripts", "build-probe.sh"));
  await chmod(join(root, "scripts", "build-probe.sh"), 0o755);
  await mkdir(join(root, "engine", "Sources", "HeadroomClaudeProbe"), { recursive: true });
  await writeFile(join(root, "engine", "Sources", "HeadroomClaudeProbe", "HeadroomClaudeProbe.swift"), "// fake source v1\n");
  await writeFile(join(root, "engine", "Package.swift"), "// fake package v1\n");

  const fakebin = join(root, "fakebin");
  await mkdir(fakebin, { recursive: true });
  const log = join(root, "fake-calls.log");
  await writeFile(log, "");
  // Writes the expected output binary at the same relative path a real
  // `swift build -c release ...` would leave it, so the script's own
  // existence check right after succeeds.
  await writeFile(join(fakebin, "swift"), [
    "#!/bin/sh",
    `echo "swift $*" >> "${log}"`,
    "mkdir -p engine/.build/release",
    "printf FAKEBINARY > engine/.build/release/headroom-claude-probe",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  await writeFile(join(fakebin, "codesign"), [
    "#!/bin/sh",
    `echo "codesign $*" >> "${log}"`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  // find-identity always reports nothing found (exit 1); set-key-partition-list
  // is logged then no-op. Never touches a real keychain -- this IS the
  // keychain, as far as the script under test knows. `import` additionally
  // recovers the -P password from its own argument list and uses the REAL
  // openssl to verify the PKCS#12 file it was handed actually opens with
  // that password -- proving the export and the import agree on one real,
  // random passphrase, while the file still exists (the real script shreds
  // it immediately after this call returns).
  await writeFile(join(fakebin, "security"), [
    "#!/bin/sh",
    `echo "security $*" >> "${log}"`,
    'case "$1" in',
    "  find-identity) exit 1 ;;",
    "  import)",
    '    p12="$2"; pass=""; prev=""',
    '    for arg in "$@"; do',
    '      if [ "$prev" = "-P" ]; then pass="$arg"; fi',
    '      prev="$arg"',
    "    done",
    '    if openssl pkcs12 -in "$p12" -passin "pass:$pass" -noout -info -legacy >/dev/null 2>&1 \\',
    '        || openssl pkcs12 -in "$p12" -passin "pass:$pass" -noout -info >/dev/null 2>&1; then',
    `      echo "p12-verified: ok ($pass)" >> "${log}"`,
    "    else",
    `      echo "p12-verified: FAILED" >> "${log}"`,
    "    fi",
    "    exit 0 ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  for (const bin of ["swift", "codesign", "security"]) await chmod(join(fakebin, bin), 0o755);

  // CI runners export CI/GITHUB_ACTIONS, which make the script sign ad-hoc
  // without touching identities; these tests exercise the identity path.
  return { root, log, env: { ...process.env, PATH: `${fakebin}:${process.env.PATH ?? ""}`, CI: "", GITHUB_ACTIONS: "" } };
}

async function run(root: string, env: NodeJS.ProcessEnv, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("bash", [join(root, "scripts", "build-probe.sh")], { cwd: root, env: { ...env, ...extraEnv } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

async function readLog(log: string): Promise<string> { try { return await readFile(log, "utf8"); } catch { return ""; } }

// The script itself is a no-op on any platform but macOS (it says so and
// exits 0 immediately); every assertion below is about the macOS-only
// behavior past that early exit, so the whole suite is scoped the same way.
describe.skipIf(process.platform !== "darwin")("build-probe.sh: signing identity", () => {
  it("signs with HEADROOM_CODESIGN_IDENTITY when set, never touching `security` at all", async () => {
    const { root, log, env } = await fakeRepo();
    const result = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "Test Signing Identity" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("signed: Test Signing Identity");
    const calls = await readLog(log);
    expect(calls).toContain("codesign --force --sign Test Signing Identity");
    expect(calls).not.toContain("security ");
  });

  it("falls back to ad-hoc with a printed warning when identity creation fails (no openssl)", async () => {
    const { root, log, env } = await fakeRepo();
    // A PATH with only the fakebin dir (plus the bare minimum the script's
    // own file operations need) has no real `openssl` on it at all.
    const minimalPath = `${join(root, "fakebin")}:/usr/bin:/bin`;
    const result = await run(root, env, { PATH: minimalPath, HEADROOM_CODESIGN_IDENTITY: "" });
    // Only meaningful if this environment's /usr/bin:/bin genuinely lacks
    // openssl (true on a stock macOS/Linux CI runner); skip rather than
    // false-fail on an unusual PATH setup where it happens to be there too.
    const hasOpenssl = await execFileAsync("sh", ["-c", `PATH="${minimalPath}" command -v openssl`]).then(() => true).catch(() => false);
    if (hasOpenssl) return;
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("falling back to ad-hoc");
    expect(result.stdout).toContain("signed: -");
    const calls = await readLog(log);
    expect(calls).toContain("codesign --force --sign -");
  });

  it("creates the 'Headroom Local' identity via openssl + a stubbed `security import`, never a real keychain write", async () => {
    const { root, log, env } = await fakeRepo();
    const result = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    // openssl itself is real here (harmless: it only writes throwaway files
    // to a temp dir); only `security import`/`find-identity` are faked, so
    // this proves the create-identity code path runs end to end without
    // ever reaching a real keychain.
    const calls = await readLog(log);
    expect(calls).toContain("security find-identity");
    expect(calls).toContain("security import");
    // find-identity always reports "not found" from the fake, so the script
    // falls back to ad-hoc after a failed creation attempt -- still a safe,
    // fully-exercised path, and never a crash.
    expect(result.code).toBe(0);
  });

  it("exports and imports the PKCS12 under one real, random per-run password, never a fixed one", async () => {
    const { root, log, env } = await fakeRepo();
    const result = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    expect(result.code).toBe(0);
    const calls = await readLog(log);
    // The fake `security import` above verified with real openssl, while
    // the PKCS12 file still existed, that the -P password it received
    // actually opens the file the export produced.
    expect(calls).toMatch(/p12-verified: ok \(\S+\)/);
    const password = /p12-verified: ok \((\S+)\)/.exec(calls)![1];
    expect(password).not.toBe("headroom"); // the former fixed, shared password
    expect(password.length).toBeGreaterThanOrEqual(32); // openssl rand -hex 24
  });

  it("two separate runs use two different passwords", async () => {
    const { root, log, env } = await fakeRepo();
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    const first = /p12-verified: ok \((\S+)\)/.exec(await readLog(log))![1];
    // A second run with unchanged source skips the rebuild (and so identity
    // creation) entirely -- change the fake source between runs, the same
    // trick the "rebuilds again once the source actually changes" test
    // below uses, so this run genuinely re-creates and re-exports. The fake
    // find-identity always reports "not found", so each rebuild that
    // reaches it re-creates the identity from scratch.
    await writeFile(join(root, "engine", "Sources", "HeadroomClaudeProbe", "HeadroomClaudeProbe.swift"), "// fake source v2 -- changed\n");
    await writeFile(join(root, "fake-calls.log"), "");
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    const second = /p12-verified: ok \((\S+)\)/.exec(await readLog(log))![1];
    expect(second).not.toBe(first);
  });

  it("imports with -T /usr/bin/codesign only, never -A", async () => {
    const { root, log, env } = await fakeRepo();
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    const calls = await readLog(log);
    const importLine = calls.split("\n").find((line) => line.startsWith("security import"));
    expect(importLine).toContain("-T /usr/bin/codesign");
    expect(importLine).not.toMatch(/(^| )-A( |$)/);
  });

  it("generates an openssl config with a real codeSigning EKU, and shreds the private key and PKCS12 immediately after import even under HEADROOM_BUILD_PROBE_KEEP_WORKDIR", async () => {
    const { root, env } = await fakeRepo();
    const result = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "", HEADROOM_BUILD_PROBE_KEEP_WORKDIR: "1" });
    expect(result.code).toBe(0);
    const workdirMatch = /HEADROOM_BUILD_PROBE_KEEP_WORKDIR set; leaving (\S+) in place/.exec(result.stderr);
    expect(workdirMatch).not.toBeNull();
    const workdir = workdirMatch![1];
    temporary.push(workdir); // the script deliberately left this in place; clean it up ourselves

    const cnf = await readFile(join(workdir, "ext.cnf"), "utf8");
    expect(cnf).toContain("extendedKeyUsage = codeSigning");
    expect(cnf).toContain("CN = Headroom Local");

    // Not just requested in the config: the certificate openssl actually
    // produced from it really carries the codeSigning EKU (OID 1.3.6.1.5.5.7.3.3).
    const certText = (await execFileAsync("openssl", ["x509", "-in", join(workdir, "cert.pem"), "-noout", "-text"])).stdout;
    expect(certText).toMatch(/Code Signing|1\.3\.6\.1\.5\.5\.7\.3\.3/);

    // HEADROOM_BUILD_PROBE_KEEP_WORKDIR keeps only the certificate
    // and the openssl config for inspection -- never the private key or the
    // PKCS12 bundle, both of which the script shreds right after import.
    await expect(access(join(workdir, "key.pem"))).rejects.toThrow();
    await expect(access(join(workdir, "cert.p12"))).rejects.toThrow();
  });
});

describe.skipIf(process.platform !== "darwin")("build-probe.sh: rebuild only when the source hash changes", () => {
  it("rebuilds on the first run and records SOURCE_SHA256 next to the binary", async () => {
    const { root, log, env } = await fakeRepo();
    const result = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "Test Identity" });
    expect(result.code).toBe(0);
    expect(await readLog(log)).toContain("swift build");
    const sourceHash = await readFile(join(root, "bin", "probe", "darwin", "SOURCE_SHA256"), "utf8");
    expect(sourceHash.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(root, "bin", "probe", "darwin", "headroom-claude-probe"), "utf8")).toBe("FAKEBINARY");
  });

  it("skips the rebuild entirely on a second run with unchanged source", async () => {
    const { root, log, env } = await fakeRepo();
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "Test Identity" });
    await writeFile(join(root, "fake-calls.log"), ""); // reset the call log between runs
    const second = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "Test Identity" });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("source unchanged");
    expect(await readLog(log)).not.toContain("swift build");
    expect(await readLog(log)).not.toContain("codesign");
  });

  it("rebuilds again once the source actually changes", async () => {
    const { root, log, env } = await fakeRepo();
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "Test Identity" });
    const firstHash = (await readFile(join(root, "bin", "probe", "darwin", "SOURCE_SHA256"), "utf8")).trim();
    await writeFile(join(root, "engine", "Sources", "HeadroomClaudeProbe", "HeadroomClaudeProbe.swift"), "// fake source v2 -- changed\n");
    await writeFile(join(root, "fake-calls.log"), "");
    const second = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "Test Identity" });
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain("source unchanged");
    expect(await readLog(log)).toContain("swift build");
    const secondHash = (await readFile(join(root, "bin", "probe", "darwin", "SOURCE_SHA256"), "utf8")).trim();
    expect(secondHash).not.toBe(firstHash);
  });

  it("also rebuilds when the recorded SHA-256 binary is missing even though SOURCE_SHA256 matches", async () => {
    const { root, log, env } = await fakeRepo();
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "Test Identity" });
    await rm(join(root, "bin", "probe", "darwin", "headroom-claude-probe"));
    await writeFile(join(root, "fake-calls.log"), "");
    const second = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "Test Identity" });
    expect(second.code).toBe(0);
    expect(await readLog(log)).toContain("swift build");
  });
});
