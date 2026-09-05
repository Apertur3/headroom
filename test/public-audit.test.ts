import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = join(__dirname, "..", "scripts", "public-audit.sh");

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

// A throwaway git repository, distinct from this project's own, so the
// audit's tracked-file and full-history checks run against fixture content
// only -- never against this repo's real history or denylist findings.
async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-public-audit-"));
  temporary.push(root);
  await execFileAsync("git", ["init", "-q", root]);
  // Assembled at runtime -- a contiguous "user@host"-shaped literal in this
  // file's own source would fail this repo's own tracked-file privacy sweep,
  // whose allow-list only excludes example.com, not GitHub's noreply domain.
  await execFileAsync("git", ["config", "user.email", ["test", "users.noreply.github.com"].join("@")], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: root });
  return root;
}

async function commitAll(root: string, message = "init"): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", message], { cwd: root });
}

async function runAudit(root: string, env: Record<string, string | undefined> = {}): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath], {
      cwd: root,
      env: {
        ...process.env,
        // Never the real developer machine's local denylist -- see the
        // identical reasoning in privacy-sweep.test.ts.
        PRIVACY_DENYLIST: join(root, "no-such-local-denylist"),
        ...env,
      },
    });
    return { code: 0, output: stdout + stderr };
  } catch (error: unknown) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, output: (result.stdout ?? "") + (result.stderr ?? "") };
  }
}

describe("scripts/public-audit.sh", () => {
  it("passes a clean repository", async () => {
    const root = await initRepo();
    await writeFile(join(root, "clean.txt"), "nothing sensitive here\n");
    await commitAll(root);
    const { code, output } = await runAudit(root);
    expect(code).toBe(0);
    expect(output).toContain("PASS");
  });

  it.skipIf(process.platform === "win32")("fails, rather than silently omitting data, on a tracked file it cannot read (POSIX mode bits)", async () => {
    const root = await initRepo();
    const target = join(root, "secretish.txt");
    await writeFile(target, "hello world\n");
    await commitAll(root);
    await chmod(target, 0o000);
    try {
      const { code, output } = await runAudit(root);
      expect(code).not.toBe(0);
      expect(output).toContain("scan error");
    } finally { await chmod(target, 0o644); }
  });

  it("fails on an invalid denylist regular expression instead of reporting no hits", async () => {
    const root = await initRepo();
    await writeFile(join(root, "clean.txt"), "nothing sensitive here\n");
    await commitAll(root);
    const denylistPath = join(root, "denylist.txt");
    await writeFile(denylistPath, "unbalanced(group\n", "utf8");
    const { code, output } = await runAudit(root, { PRIVACY_DENYLIST: denylistPath });
    expect(code).not.toBe(0);
    expect(output).toContain("invalid denylist expression");
  });

  it("scans a tracked filename containing a space via NUL-delimited git ls-files/xargs", async () => {
    const root = await initRepo();
    const denylistPath = join(root, "denylist.txt");
    await writeFile(denylistPath, "needle-pattern-marker\n", "utf8");
    const spaced = join(root, "a file with spaces.txt");
    await writeFile(spaced, "needle-pattern-marker\n");
    await commitAll(root);
    const { code, output } = await runAudit(root, { PRIVACY_DENYLIST: denylistPath });
    expect(code).not.toBe(0);
    expect(output).toContain("denylist hit in files");
    expect(output).toContain("a file with spaces.txt");
  });

  it("fails on a committed archive/binary file", async () => {
    const root = await initRepo();
    await writeFile(join(root, "release.tgz"), "not a real tarball");
    await commitAll(root);
    const { code, output } = await runAudit(root);
    expect(code).not.toBe(0);
    expect(output).toContain("archive tracked");
  });

  it("fails on a commit identity that is not a GitHub noreply address", async () => {
    const root = await initRepo();
    // A real-shaped but non-noreply address; example.com keeps it out of
    // this repo's own privacy sweep (its allow-list only excludes that domain).
    await execFileAsync("git", ["config", "user.email", "real-person@example.com"], { cwd: root });
    await writeFile(join(root, "clean.txt"), "nothing sensitive here\n");
    await commitAll(root);
    const { code, output } = await runAudit(root);
    expect(code).not.toBe(0);
    expect(output).toContain("personal email in commit metadata");
  });
});
