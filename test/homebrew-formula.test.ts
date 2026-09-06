import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = join(__dirname, "..", "scripts", "homebrew-formula.sh");
const expectedPath = join(__dirname, "fixtures", "homebrew", "headroom.rb.expected");
const seedPath = join(__dirname, "..", "docs", "homebrew-tap-seed", "Formula", "headroom.rb");
const packagePath = join(__dirname, "..", "package.json");

// The fixture and the seed are checked in with LF endings (.gitattributes
// pins eol=lf), and the script emits LF. Stripping CR anyway keeps the
// comparison an exact text match on a Windows checkout that ignored that.
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

const SYNTHETIC = {
  version: "9.9.9-test.1",
  url: "https://registry.npmjs.org/headroomd/-/headroomd-9.9.9-test.1.tgz",
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function generate(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath, ...args]);
    return { code: 0, stdout: lf(stdout), stderr: lf(stderr) };
  } catch (error: unknown) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: lf(result.stdout ?? ""), stderr: lf(result.stderr ?? "") };
  }
}

/** Is a real ruby on PATH? `ruby -c` is the closest thing to `brew audit` available offline. */
let rubyChecked = false;
let rubyAvailable = false;
async function haveRuby(): Promise<boolean> {
  if (rubyChecked) return rubyAvailable;
  rubyChecked = true;
  try { await execFileAsync("ruby", ["-e", "exit 0"]); rubyAvailable = true; } catch { rubyAvailable = false; }
  return rubyAvailable;
}

/**
 * The offline stand-in for `brew audit --strict`: ruby's own parser when ruby
 * is present, plus the structural rules a Homebrew formula has to satisfy that
 * a syntax check would never catch (desc style, the stanzas brew requires, the
 * service and test blocks this formula exists for).
 */
async function auditFormula(formula: string, expected: { version: string; url: string; sha256: string }): Promise<void> {
  if (await haveRuby()) {
    const root = await mkdtemp(join(tmpdir(), "headroom-brew-")); temporary.push(root);
    const file = join(root, "headroom.rb");
    await writeFile(file, formula, "utf8");
    const { stdout } = await execFileAsync("ruby", ["-c", file]);
    expect(stdout.trim()).toBe("Syntax OK");
  } else {
    // No ruby: check the shape by hand. Every block opener has to be closed,
    // and the class has to be closed last.
    const openers = (formula.match(/^\s*(class |def |do$|\S+ do$)/gm) ?? []).length;
    const ends = (formula.match(/^\s*end$/gm) ?? []).length;
    expect(ends).toBe(openers);
    expect(formula.trimEnd().endsWith("\nend")).toBe(true);
  }

  // The class name Homebrew derives from the file name Formula/headroom.rb.
  expect(formula).toMatch(/^class Headroom < Formula$/m);

  // desc: one line, no trailing period, under brew's 80-character limit, and
  // it may not start with an article or repeat the formula name.
  const desc = /^ {2}desc "([^"]+)"$/m.exec(formula);
  expect(desc).not.toBeNull();
  const text = desc![1];
  expect(text.length).toBeLessThan(80);
  expect(text.endsWith(".")).toBe(false);
  expect(text).not.toMatch(/^(A|An|The|Headroom)\b/);

  // The stanzas brew requires, in the order brew's own style check wants them.
  const order = ["desc", "homepage", "url", "version", "sha256", "license", "depends_on", "def install", "def caveats", "service do", "test do"];
  let cursor = -1;
  for (const stanza of order) {
    const at = formula.indexOf(`\n  ${stanza}`);
    expect(at, `${stanza} is missing`).toBeGreaterThan(-1);
    expect(at, `${stanza} is out of order`).toBeGreaterThan(cursor);
    cursor = at;
  }

  expect(formula).toContain(`  url "${expected.url}"\n`);
  expect(formula).toContain(`  version "${expected.version}"\n`);
  expect(formula).toContain(`  sha256 "${expected.sha256}"\n`);
  expect(formula).toContain('  license "MIT"\n');
  expect(formula).toContain('  homepage "https://github.com/Apertur3/headroom"\n');

  // Node, and only node: nothing here may depend on a Keychain probe being
  // built at install time.
  expect(formula.match(/^[ \t]*depends_on .*$/gm)).toEqual(['  depends_on "node"']);
  expect(formula).not.toMatch(/xcode|swift|macos_only|security find-generic-password/i);

  // The Homebrew Node install pattern: install into libexec, symlink the bin.
  expect(formula).toContain('system "npm", "install", *std_npm_args');
  expect(formula).toContain('bin.install_symlink Dir["#{libexec}/bin/*"]');

  // The service block is the whole point of the tap: `brew services start
  // headroom` has to run the daemon and keep it running, with both logs under
  // Homebrew's own var/log.
  expect(formula).toContain('run [opt_bin/"headroom", "daemon"]');
  expect(formula).toContain("keep_alive true");
  expect(formula).toContain('log_path var/"log/headroom/headroom.log"');
  expect(formula).toContain('error_log_path var/"log/headroom/headroom.error.log"');
  // Homebrew does not create the log directory for a service.
  expect(formula).toContain('(var/"log/headroom").mkpath');

  expect(formula).toContain('assert_match version.to_s, shell_output("#{bin}/headroom version")');
}

describe("scripts/homebrew-formula.sh", () => {
  it("prints exactly the checked-in expected formula for a fixed input", async () => {
    const result = await generate([SYNTHETIC.version, SYNTHETIC.url, SYNTHETIC.sha256]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(lf(await readFile(expectedPath, "utf8")));
  });

  it("embeds the sha256 of the actual tarball bytes it is handed", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-brew-tarball-")); temporary.push(root);
    // A fake release tarball: the script never opens it, so any bytes will do,
    // but hashing a real file is what a maintainer and the release job do.
    const tarball = join(root, "headroomd-1.2.3.tgz");
    await writeFile(tarball, Buffer.from("not really a tarball, but bytes with a hash\n"));
    const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
    const url = "https://registry.npmjs.org/headroomd/-/headroomd-1.2.3.tgz";

    const result = await generate(["1.2.3", url, sha256]);
    expect(result.code).toBe(0);
    await auditFormula(result.stdout, { version: "1.2.3", url, sha256 });
  });

  it("refuses arguments that could become formula code, and every other malformed input", async () => {
    const good = [SYNTHETIC.version, SYNTHETIC.url, SYNTHETIC.sha256] as const;
    const bad: Array<[string, string[]]> = [
      ["a version that closes the Ruby string", ['1.0.0" + `id` + "', good[1], good[2]]],
      ["a version with a Ruby interpolation", ['1.0.0#{system("id")}', good[1], good[2]]],
      ["a url that closes the Ruby string", [good[0], 'https://a.example/x.tgz"; system "id"; "', good[2]]],
      ["a url that is not https", [good[0], "http://registry.npmjs.org/headroomd/-/headroomd-1.0.0.tgz", good[2]]],
      ["a url that is not a tarball", [good[0], "https://registry.npmjs.org/headroomd", good[2]]],
      ["an uppercase sha256", [good[0], good[1], good[2].toUpperCase()]],
      ["a short sha256", [good[0], good[1], "abc123"]],
      ["a leading v on the version", [`v${good[0]}`, good[1], good[2]]],
      ["too few arguments", [good[0], good[1]]],
      ["too many arguments", [good[0], good[1], good[2], "extra"]],
    ];
    for (const [label, args] of bad) {
      const result = await generate(args);
      expect(result.code, label).not.toBe(0);
      expect(result.stdout, label).toBe("");
      expect(result.stderr, label).toContain("homebrew-formula:");
    }
  });
});

describe("docs/homebrew-tap-seed", () => {
  it("holds the formula this script generates for the version it declares", async () => {
    const seed = lf(await readFile(seedPath, "utf8"));
    const version = /^ {2}version "([^"]+)"$/m.exec(seed)?.[1];
    const url = /^ {2}url "([^"]+)"$/m.exec(seed)?.[1];
    const sha256 = /^ {2}sha256 "([^"]+)"$/m.exec(seed)?.[1];
    expect(version, "seed formula has no version").toBeTruthy();
    expect(url, "seed formula has no url").toBeTruthy();
    expect(sha256, "seed formula has no sha256").toBeTruthy();

    const result = await generate([version!, url!, sha256!]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(seed);
    await auditFormula(seed, { version: version!, url: url!, sha256: sha256! });
    // The seed points at the real published tarball for that version.
    expect(url).toBe(`https://registry.npmjs.org/headroomd/-/headroomd-${version}.tgz`);
  });

  it("stays out of the npm package: no `files` entry reaches into a docs subdirectory", async () => {
    const files: string[] = JSON.parse(await readFile(packagePath, "utf8")).files;
    const docsEntries = files.filter((entry) => entry.startsWith("docs"));
    expect(docsEntries.length).toBeGreaterThan(0);
    for (const entry of docsEntries) {
      // A `**` anywhere under docs would sweep up docs/homebrew-tap-seed/ (and
      // docs/reports/) into the published package. Every entry names the
      // directory it reads from explicitly instead.
      expect(entry, `${entry} may match a docs subdirectory`).not.toContain("**");
      expect(entry, `${entry} names no file pattern`).toMatch(/\/\*[^/]*$/);
      expect(entry.startsWith("docs/homebrew-tap-seed"), `${entry} ships the tap seed`).toBe(false);
    }
  });
});
