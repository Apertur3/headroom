import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

// Shells out to swiftc and openssl; under parallel load the default 5s per test is too tight.
vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);
const realScript = join(__dirname, "..", "scripts", "build-probe.sh");

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/**
 * A self-contained fake repo: the real build-probe.sh script (copied
 * verbatim), a throwaway engine/ source tree, and a fakebin/ directory put
 * first on PATH so `swift`, `codesign`, `security`, and `git` never touch a
 * real Swift toolchain, a real signature, a real keychain, or a real git
 * config. HOME points at the fake repo too, so the signing keychain the
 * script derives from it is inside the throwaway tree. Every test below runs
 * the REAL script logic (hash computation, the skip decision, identity
 * resolution, the timeout and the fallback path) against these fakes --
 * nothing here is a reimplementation of the script's own behavior.
 */
async function fakeRepo(): Promise<{ root: string; log: string; state: string; keychain: string; env: NodeJS.ProcessEnv }> {
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
  // One line per identity the fake keychain holds, so the fake `security`
  // behaves like a keychain with memory: an import adds one, find-identity
  // lists them back, delete-identity removes one. That memory is what lets a
  // test tell "created once, then reused" apart from "created twice".
  const state = join(root, "fake-keychain-state");
  await writeFile(state, "");
  const keychain = join(root, "Library", "Keychains", "headroom-local-signing.keychain-db");
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
  // Signing ad-hoc ("-") always returns at once. Signing with a real
  // identity blocks forever when FAKE_CODESIGN_HANG is set, standing in for
  // the Keychain dialog nobody is there to click; `exec` so the script's
  // kill lands on the sleep itself and leaves no orphan behind.
  await writeFile(join(fakebin, "codesign"), [
    "#!/bin/sh",
    `echo "codesign $*" >> "${log}"`,
    'for arg in "$@"; do [ "$arg" = "-" ] && exit 0; done',
    '[ -n "$FAKE_CODESIGN_HANG" ] && exec sleep 120',
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  // Never touches a real keychain -- this IS the keychain, as far as the
  // script under test knows. `import` additionally recovers the -P password
  // from its own argument list and uses the REAL openssl to verify the
  // PKCS#12 file it was handed actually opens with that password -- proving
  // the export and the import agree on one real, random passphrase, while
  // the file still exists (the real script shreds it immediately after this
  // call returns).
  await writeFile(join(fakebin, "security"), [
    "#!/bin/sh",
    `echo "security $*" >> "${log}"`,
    `STATE="${state}"`,
    'cmd="$1"; shift',
    'case "$cmd" in',
    "  create-keychain)",
    '    kc=""; for arg in "$@"; do kc="$arg"; done',
    '    mkdir -p "$(dirname "$kc")" && : > "$kc"',
    "    exit 0 ;;",
    "  delete-keychain)",
    '    for arg in "$@"; do case "$arg" in /*) rm -f "$arg" ;; esac; done',
    "    exit 0 ;;",
    "  find-identity)",
    '    [ -s "$STATE" ] || exit 1',
    "    n=0",
    '    while IFS= read -r line; do',
    '      [ -n "$line" ] || continue',
    "      n=$((n + 1))",
    `      printf '  %d) %s "Headroom Local" (CSSMERR_TP_NOT_TRUSTED)\\n' "$n" "$line"`,
    '    done < "$STATE"',
    "    exit 0 ;;",
    "  import)",
    '    p12="$1"; pass=""; prev=""',
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
    '    od -An -tx1 -N20 /dev/urandom | tr -d " \\n" | tr "a-f" "A-F" >> "$STATE"',
    '    echo >> "$STATE"',
    '    echo "1 identity imported."',
    "    exit 0 ;;",
    "  delete-identity)",
    '    target=""; prev=""',
    '    for arg in "$@"; do',
    '      if [ "$prev" = "-Z" ]; then target="$arg"; fi',
    '      prev="$arg"',
    "    done",
    '    grep -v -x "$target" "$STATE" > "$STATE.next" 2>/dev/null',
    '    mv "$STATE.next" "$STATE"',
    "    exit 0 ;;",
    '  find-certificate) [ -s "$STATE" ] || exit 1; exit 0 ;;',
    "  delete-certificate)",
    '    sed "\\$d" "$STATE" > "$STATE.next" 2>/dev/null',
    '    mv "$STATE.next" "$STATE"',
    "    exit 0 ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  // The script reads `git config --get headroom.codesign-identity` as an
  // alternative to the environment variable. A fake keeps that read off the
  // developer's own git config: it answers only what FAKE_GIT_IDENTITY says.
  await writeFile(join(fakebin, "git"), [
    "#!/bin/sh",
    `echo "git $*" >> "${log}"`,
    '[ -n "$FAKE_GIT_IDENTITY" ] || exit 1',
    'printf "%s\\n" "$FAKE_GIT_IDENTITY"',
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  for (const bin of ["swift", "codesign", "security", "git"]) await chmod(join(fakebin, bin), 0o755);

  // CI runners export CI/GITHUB_ACTIONS, which make the script sign ad-hoc
  // without touching identities; these tests exercise the identity path.
  // HOME is the fake repo so the signing keychain path lands inside it.
  return {
    root, log, state, keychain,
    env: {
      ...process.env,
      PATH: `${fakebin}:${process.env.PATH ?? ""}`,
      HOME: root,
      CI: "",
      GITHUB_ACTIONS: "",
      FAKE_CODESIGN_HANG: "",
      FAKE_GIT_IDENTITY: "",
    },
  };
}

/** Prepends a logging wrapper around the REAL openssl, so a test can assert
 * the exact argument lists the script builds without giving up openssl's
 * real behavior (the certificate and the PKCS#12 bundle are genuine). Kept
 * opt-in: the "no openssl on PATH" test needs a PATH where openssl really is
 * absent. */
async function logOpenssl(root: string, log: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const real = (await execFileAsync("sh", ["-c", "command -v openssl"])).stdout.trim();
  const wrapbin = join(root, "wrapbin");
  await mkdir(wrapbin, { recursive: true });
  await writeFile(join(wrapbin, "openssl"), [
    "#!/bin/sh",
    `echo "openssl $*" >> "${log}"`,
    `exec "${real}" "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  await chmod(join(wrapbin, "openssl"), 0o755);
  return { ...env, PATH: `${wrapbin}:${env.PATH ?? ""}` };
}

async function runArgs(root: string, env: NodeJS.ProcessEnv, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("bash", [join(root, "scripts", "build-probe.sh"), ...args], { cwd: root, env: { ...env, ...extraEnv } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

const runReset = (root: string, env: NodeJS.ProcessEnv, extraEnv: NodeJS.ProcessEnv = {}) => runArgs(root, env, ["--reset-identity"], extraEnv);

/** Every SHA-1 hash the fake keychain currently holds. */
async function identityHashes(state: string): Promise<string[]> {
  try { return (await readFile(state, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean); }
  catch { return []; }
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
    const { root, log, state, env } = await fakeRepo();
    const result = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    // openssl itself is real here (harmless: it only writes throwaway files
    // to a temp dir); only `security` is faked, so this proves the
    // create-identity code path runs end to end without ever reaching a
    // real keychain.
    const calls = await readLog(log);
    expect(calls).toContain("security find-identity");
    expect(calls).toContain("security import");
    expect(result.code).toBe(0);
    // Exactly one identity, and codesign signed with that identity's SHA-1
    // hash rather than its name: signing by name is what broke on a machine
    // that had accumulated duplicates ("ambiguous (matches ... and ...)").
    const hashes = await identityHashes(state);
    expect(hashes).toHaveLength(1);
    expect(calls).toContain(`codesign --force --sign ${hashes[0]}`);
    expect(result.stdout).toContain(`signed: Headroom Local (${hashes[0]})`);
  });

  it("reuses the one identity on a later build instead of creating a second", async () => {
    const { root, log, state, env } = await fakeRepo();
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    const first = await identityHashes(state);
    expect(first).toHaveLength(1);
    // Change the source so the rebuild skip does not hide the identity path.
    await writeFile(join(root, "engine", "Sources", "HeadroomClaudeProbe", "HeadroomClaudeProbe.swift"), "// fake source v2 -- changed\n");
    await writeFile(join(root, "fake-calls.log"), "");
    const second = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    expect(second.code).toBe(0);
    // Same identity, no second import: the designated requirement the
    // Keychain ACL was granted against is unchanged, so an existing grant
    // still covers the freshly built binary.
    expect(await identityHashes(state)).toEqual(first);
    const calls = await readLog(log);
    expect(calls).not.toContain("security import");
    expect(calls).toContain(`codesign --force --sign ${first[0]}`);
  });

  it("signs by hash and warns when a machine has accumulated duplicate identities", async () => {
    const { root, log, state, env } = await fakeRepo();
    // Two identities of the same name, the state this defect left behind.
    await writeFile(state, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n");
    const result = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("2 'Headroom Local' identities found");
    expect(result.stderr).toContain("--reset-identity");
    // Still a real sign, by hash, never the ambiguous name.
    const calls = await readLog(log);
    expect(calls).toContain("codesign --force --sign AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(calls).not.toContain("codesign --force --sign Headroom Local");
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

  it("two separate creations use two different passwords", async () => {
    const { root, log, state, env } = await fakeRepo();
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    const first = /p12-verified: ok \((\S+)\)/.exec(await readLog(log))![1];
    // A second run with unchanged source skips the rebuild (and so identity
    // creation) entirely, and a run that finds the identity already there
    // reuses it -- change the fake source AND empty the fake keychain, so
    // this run genuinely re-creates and re-exports, the way a second machine
    // would.
    await writeFile(join(root, "engine", "Sources", "HeadroomClaudeProbe", "HeadroomClaudeProbe.swift"), "// fake source v2 -- changed\n");
    await writeFile(state, "");
    await writeFile(join(root, "fake-calls.log"), "");
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    const second = /p12-verified: ok \((\S+)\)/.exec(await readLog(log))![1];
    expect(second).not.toBe(first);
  });

  it("builds the openssl key-pair and PKCS12 argument lists the way macOS can import", async () => {
    const { root, log, env } = await fakeRepo();
    const withOpenssl = await logOpenssl(root, log, env);
    const result = await run(root, withOpenssl, { HEADROOM_CODESIGN_IDENTITY: "" });
    expect(result.code).toBe(0);
    const calls = (await readLog(log)).split("\n");
    const req = calls.find((line) => line.startsWith("openssl req"));
    expect(req).toMatch(/^openssl req -x509 -newkey rsa:2048 -keyout \S+\/key\.pem -out \S+\/cert\.pem -days 36500 -nodes -config \S+\/ext\.cnf -extensions v3_req$/);
    const p12 = calls.find((line) => line.startsWith("openssl pkcs12"));
    // -legacy is what makes the bundle readable by macOS's Security
    // framework at all; the passphrase is the run's own random value, never
    // a fixed one, and never written to a file.
    expect(p12).toMatch(/^openssl pkcs12 -export -in \S+\/cert\.pem -inkey \S+\/key\.pem -out \S+\/cert\.p12 -passout pass:[0-9a-f]{48} -name Headroom Local -legacy$/);
  });

  it("imports into the dedicated signing keychain with -T /usr/bin/codesign only, never -A", async () => {
    const { root, log, keychain, env } = await fakeRepo();
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    const calls = await readLog(log);
    const importLine = calls.split("\n").find((line) => line.startsWith("security import"));
    expect(importLine).toMatch(new RegExp(`^security import \\S+/cert\\.p12 -k ${keychain} -P [0-9a-f]{48} -T /usr/bin/codesign$`));
    expect(importLine).not.toMatch(/(^| )-A( |$)/);
    // The partition list is what keeps codesign from stopping on a Keychain
    // dialog on every later sign, and it can only be set on a keychain whose
    // passphrase the script knows -- which is why the identity is not in the
    // login keychain.
    expect(calls).toContain(`security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k  ${keychain}`);
    expect(calls).not.toContain("login.keychain-db");
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

describe.skipIf(process.platform !== "darwin")("build-probe.sh: configured identities", () => {
  it("signs with `git config headroom.codesign-identity` when no environment variable is set", async () => {
    const { root, log, state, env } = await fakeRepo();
    const result = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "", FAKE_GIT_IDENTITY: "Developer ID Application: Example (ABCDE12345)" });
    expect(result.code).toBe(0);
    const calls = await readLog(log);
    expect(calls).toContain("git -C");
    expect(calls).toContain("config --get headroom.codesign-identity");
    expect(calls).toContain("codesign --force --sign Developer ID Application: Example (ABCDE12345)");
    expect(result.stdout).toContain("signed: Developer ID Application: Example (ABCDE12345)");
    // A configured identity replaces the local one outright: nothing is
    // created, nothing is imported.
    expect(calls).not.toContain("security import");
    expect(await identityHashes(state)).toHaveLength(0);
  });

  it("prefers HEADROOM_CODESIGN_IDENTITY over the git config value", async () => {
    const { root, log, env } = await fakeRepo();
    const result = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "From Environment", FAKE_GIT_IDENTITY: "From Git Config" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("signed: From Environment");
    const calls = await readLog(log);
    expect(calls).toContain("codesign --force --sign From Environment");
    expect(calls).not.toContain("From Git Config");
  });

  it("falls back to ad-hoc with a warning when a configured identity cannot sign in time, instead of hanging", async () => {
    const { root, log, env } = await fakeRepo();
    const started = Date.now();
    const result = await run(root, env, {
      HEADROOM_CODESIGN_IDENTITY: "Stuck On A Dialog",
      FAKE_CODESIGN_HANG: "1",
      HEADROOM_CODESIGN_TIMEOUT_SECONDS: "2",
    });
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(45_000); // the fake codesign would otherwise block for 120s
    expect(result.stderr).toContain("did not finish within 2s");
    expect(result.stderr).toContain("Falling back to ad-hoc");
    expect(result.stdout).toContain("signed: -");
    const calls = await readLog(log);
    expect(calls).toContain("codesign --force --sign Stuck On A Dialog");
    expect(calls).toContain("codesign --force --sign -");
    // The build still produced a signed binary and its recorded hash.
    expect((await readFile(join(root, "bin", "probe", "darwin", "SHA256"), "utf8")).trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(process.platform !== "darwin")("build-probe.sh: --reset-identity", () => {
  it("deletes the identity, its certificate and its keychain, and makes the next build create one fresh", async () => {
    const { root, log, state, keychain, env } = await fakeRepo();
    await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    const created = await identityHashes(state);
    expect(created).toHaveLength(1);
    await access(keychain); // the dedicated keychain exists before the reset

    await writeFile(join(root, "fake-calls.log"), "");
    const reset = await runReset(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain("removed 1 'Headroom Local' keychain item(s)");
    const calls = await readLog(log);
    expect(calls).toContain(`security delete-identity -Z ${created[0]}`);
    expect(calls).toContain("security delete-keychain");
    expect(await identityHashes(state)).toHaveLength(0);
    await expect(access(keychain)).rejects.toThrow();
    // The recorded source hash goes with it, or the next build would reuse a
    // binary signed by the identity that no longer exists.
    await expect(access(join(root, "bin", "probe", "darwin", "SOURCE_SHA256"))).rejects.toThrow();
    // Never a build: --reset-identity is a maintenance action on its own.
    expect(calls).not.toContain("swift build");

    await writeFile(join(root, "fake-calls.log"), "");
    const rebuilt = await run(root, env, { HEADROOM_CODESIGN_IDENTITY: "" });
    expect(rebuilt.code).toBe(0);
    const fresh = await identityHashes(state);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).not.toBe(created[0]);
  });

  it("rejects any other argument rather than silently building", async () => {
    const { root, env } = await fakeRepo();
    const result = await runArgs(root, env, ["--reset-identitiy"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown argument");
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
