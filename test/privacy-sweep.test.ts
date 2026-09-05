import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = join(__dirname, "..", "scripts", "privacy-sweep.sh");

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function checkFile(contents: string, opts: { denylist?: string } = {}): Promise<{ code: number; stdout: string }> {
  const root = await mkdtemp(join(tmpdir(), "headroom-privacy-sweep-"));
  temporary.push(root);
  const target = join(root, "fixture.txt");
  await writeFile(target, contents, "utf8");
  const args = ["--check", target];
  if (opts.denylist) args.push("--denylist", opts.denylist);
  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath, ...args], {
      env: {
        ...process.env,
        // scripts/privacy-sweep.sh merges in an untracked local denylist
        // (PRIVACY_DENYLIST, or ~/.config/headroom-privacy-denylist) that
        // holds real machine/person names on a developer's own machine.
        // Point it at a path that can never exist so every check here runs
        // against only the tracked denylist (or the one --denylist names
        // above) -- never a real local list, and never CI's total absence
        // of one either.
        PRIVACY_DENYLIST: join(root, "no-such-local-denylist"),
      },
    });
    return { code: 0, stdout: stdout + stderr };
  } catch (error: unknown) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: (result.stdout ?? "") + (result.stderr ?? "") };
  }
}

// Every "bad" fixture value below is assembled at runtime (never a literal
// contiguous match in this file's own source) -- this test file is itself a
// tracked file the sweep scans, so a literal private IP, real email, real
// username, or denylist word written here would fail the sweep on itself.
// Same trick test/rename.test.ts already uses for a retired brand name.
const privateIps = ["10", "1", "2", "3"].join(".") + " " + ["192", "168", "0", "9"].join(".") + " " + ["172", "20", "5", "5"].join(".") + " " + ["100", "64", "0", "5"].join(".");
const realEmail = ["owner", "gmail.com"].join("@");
const realUsername = ["john", "doe"].join("");
const realHomePath = ["/Users", realUsername, ".headroom/accounts.toml"].join("/");
const denylistWord = ["Hy", "dra"].join("");

describe("scripts/privacy-sweep.sh --check", () => {
  it("fails on a private IPv4 address", async () => {
    const ip = privateIps.split(" ")[0];
    const { code, stdout } = await checkFile(`internal box at ${ip} for testing\n`);
    expect(code).not.toBe(0);
    expect(stdout).toContain("private IPv4 address");
  });

  it("fails on each private range: 10.x, 192.168.x, 172.16-31.x, and 100.64.x", async () => {
    for (const ip of privateIps.split(" ")) {
      const { code, stdout } = await checkFile(`address ${ip} here\n`);
      expect(code, `expected ${ip} to fail`).not.toBe(0);
      expect(stdout).toContain("private IPv4 address");
    }
  });

  it("does not flag a documentation-reserved IP (RFC 5737) as private", async () => {
    const { code } = await checkFile("example box at 192.0.2.20\n");
    expect(code).toBe(0);
  });

  it("fails on a real email address, but not one at example.com", async () => {
    const real = await checkFile(`contact ${realEmail} for help\n`);
    expect(real.code).not.toBe(0);
    expect(real.stdout).toContain("email address");
    const documented = await checkFile("contact owner@example.com for help\n");
    expect(documented.code).toBe(0);
  });

  it("fails on a home path with a real username, but not an allowed placeholder", async () => {
    const real = await checkFile(`wrote ${realHomePath}\n`);
    expect(real.code).not.toBe(0);
    expect(real.stdout).toContain("real username");
    const placeholder = await checkFile("wrote /Users/you/.headroom/accounts.toml\n");
    expect(placeholder.code).toBe(0);
  });

  it("fails on a denylist match (case-insensitive)", async () => {
    // The tracked .privacy-denylist is generic-only (see its own header) --
    // real machine/person names live only in an untracked local list, which
    // checkFile() above deliberately keeps out of this run. So this test
    // supplies its own throwaway denylist: a case-insensitive pattern for
    // denylistWord, matched here against a differently-cased occurrence to
    // actually exercise the (?i) case-folding rather than a literal match.
    const root = await mkdtemp(join(tmpdir(), "headroom-privacy-denylist-"));
    temporary.push(root);
    const denylistPath = join(root, "denylist.txt");
    await writeFile(denylistPath, `(?i)${denylistWord.toLowerCase()}\n`, "utf8");
    const { code, stdout } = await checkFile(`deployed to ${denylistWord} last night\n`, { denylist: denylistPath });
    expect(code).not.toBe(0);
    expect(stdout).toContain("denylist match");
  });

  it("passes a clean file", async () => {
    const { code } = await checkFile("nothing sensitive here at all\n");
    expect(code).toBe(0);
  });

  it("fails, and never reports PASS, on a nonexistent --check input", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-privacy-sweep-missing-"));
    temporary.push(root);
    const missing = join(root, "does-not-exist.txt");
    try {
      const { stdout } = await execFileAsync("bash", [scriptPath, "--check", missing], {
        env: { ...process.env, PRIVACY_DENYLIST: join(root, "no-such-local-denylist") },
      });
      // A passing exit here would already be the bug; fail loudly if it happens.
      expect(stdout).not.toContain("PASS");
    } catch (error: unknown) {
      const result = error as { code?: number; stdout?: string; stderr?: string };
      expect(result.code).not.toBe(0);
      expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toContain("missing or unreadable");
    }
  });

  it("fails on an invalid denylist regular expression instead of reporting no hits", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-privacy-denylist-invalid-"));
    temporary.push(root);
    const denylistPath = join(root, "denylist.txt");
    // An unbalanced group is a syntax error for extended regular expressions.
    await writeFile(denylistPath, "unbalanced(group\n", "utf8");
    const { code, stdout } = await checkFile("nothing sensitive here at all\n", { denylist: denylistPath });
    expect(code).not.toBe(0);
    expect(stdout).toContain("invalid denylist expression");
  });

  it("covers the full RFC 6598 CGNAT /10 block, not just the 100.64.x /16", async () => {
    // Assembled at runtime, same trick as privateIps above: a literal
    // contiguous CGNAT address in this file's own source would fail this
    // repo's own tracked-file sweep.
    const cgnatIps = [
      ["100", "64", "0", "5"].join("."),
      ["100", "90", "1", "1"].join("."),
      ["100", "127", "255", "254"].join("."),
    ];
    for (const ip of cgnatIps) {
      const { code, stdout } = await checkFile(`address ${ip} here\n`);
      expect(code, `expected ${ip} to fail`).not.toBe(0);
      expect(stdout).toContain("private IPv4 address");
    }
    // 100.128.x.x and above is outside RFC 6598 and must not be flagged.
    const outsideCgnat = ["100", "128", "0", "1"].join(".");
    const { code } = await checkFile(`address ${outsideCgnat} here\n`);
    expect(code).toBe(0);
  });
});
