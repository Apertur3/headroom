import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

// Builds throwaway git repos and shells out to bash; Git Bash on Windows is slow.
vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);
const realScript = join(__dirname, "..", "scripts", "ci-scope.sh");
const EMAIL = "dev@example.com";
const PR_ENV = { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" };

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "dev", GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: "dev", GIT_COMMITTER_EMAIL: EMAIL,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return stdout.trim();
}

async function put(root: string, path: string, content = "x\n"): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** A repo with a base commit on main that holds one file in each interesting area. */
async function baseRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-ci-scope-")); temporary.push(root);
  await git(root, "init", "-q", "-b", "main");
  for (const path of ["README.md", "docs/quickstart.md", "src/cli.ts", "package.json", ".github/workflows/ci.yml"]) await put(root, path);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base");
  return root;
}

/**
 * Applies `change` on a PR branch, moves main on by one unrelated commit, then
 * builds GitHub's synthetic merge commit ("Merge <pr> into <main>") on main.
 */
async function prMerge(root: string, change: (root: string) => Promise<void>, subject?: (pr: string, main: string) => string): Promise<void> {
  await git(root, "checkout", "-q", "-b", "pr");
  await change(root);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "--allow-empty", "-m", "pr work");
  await git(root, "checkout", "-q", "main");
  await git(root, "commit", "-q", "--allow-empty", "-m", "main work");
  const main = await git(root, "rev-parse", "HEAD");
  const pr = await git(root, "rev-parse", "pr");
  const message = subject ? subject(pr, main) : `Merge ${pr} into ${main}`;
  await git(root, "merge", "-q", "--no-ff", "pr", "-m", message);
}

async function scope(root: string, env: Record<string, string | undefined> = PR_ENV): Promise<{ stdout: string; stderr: string; code: number }> {
  const merged: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  delete merged.GITHUB_EVENT_NAME;
  delete merged.GITHUB_REF;
  for (const [key, value] of Object.entries(env)) if (value !== undefined) merged[key] = value;
  return execFileAsync("bash", [realScript], { cwd: root, env: merged }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (e: { stdout: string; stderr: string; code: number }) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }),
  );
}

async function expectScope(root: string, docsOnly: boolean, env?: Record<string, string | undefined>): Promise<string> {
  const result = await scope(root, env);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`docs_only=${docsOnly}\n`);
  return result.stderr;
}

describe("scripts/ci-scope.sh", () => {
  it("docs-only PR merge commit => true, and names the files in the log line", async () => {
    const root = await baseRepo();
    await prMerge(root, async (r) => {
      await put(r, "README.md", "new\n");
      await put(r, "docs/concepts.md", "new\n");
      await put(r, "CHANGELOG.md", "new\n");
      await put(r, ".github/ISSUE_TEMPLATE/bug.md", "new\n");
      await put(r, ".github/PULL_REQUEST_TEMPLATE.md", "new\n");
    });
    const log = await expectScope(root, true);
    expect(log).toContain("docs-only change: heavy jobs skipped (scope: ");
    expect(log).toContain("docs/concepts.md");
  });

  it("mixed docs + src => false", async () => {
    const root = await baseRepo();
    await prMerge(root, async (r) => { await put(r, "README.md", "new\n"); await put(r, "src/cli.ts", "new\n"); });
    expect(await expectScope(root, false)).toContain("src/cli.ts");
  });

  it("only a workflow change => false", async () => {
    const root = await baseRepo();
    await prMerge(root, async (r) => { await put(r, ".github/workflows/ci.yml", "new\n"); });
    await expectScope(root, false);
  });

  it("only package.json => false", async () => {
    const root = await baseRepo();
    await prMerge(root, async (r) => { await put(r, "package.json", "{}\n"); });
    await expectScope(root, false);
  });

  it("empty diff => false", async () => {
    const root = await baseRepo();
    await prMerge(root, async () => {});
    expect(await expectScope(root, false)).toContain("empty diff");
  });

  it("push event, tag push and a missing event => false, even on a docs-only merge", async () => {
    const root = await baseRepo();
    await prMerge(root, async (r) => { await put(r, "README.md", "new\n"); });
    await expectScope(root, false, { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" });
    await expectScope(root, false, { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.0.0" });
    await expectScope(root, false, { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/master" });
    await expectScope(root, false, {});
  });

  it("non-merge HEAD => false", async () => {
    const root = await baseRepo();
    await put(root, "README.md", "new\n");
    await git(root, "commit", "-q", "-am", "docs");
    await expectScope(root, false);
  });

  it("a two-parent merge without GitHub's synthetic subject => false", async () => {
    const root = await baseRepo();
    await prMerge(root, async (r) => { await put(r, "README.md", "new\n"); }, () => "Merge branch 'pr'");
    await expectScope(root, false);
  });

  it("unknown paths, look-alikes and dotfiles => false", async () => {
    for (const path of ["notes.txt", "src/README.md", "docs", "README.md.bak", ".gitattributes", "docsx/a.md", "scripts/ci-scope.sh", "examples/a.toml"]) {
      const root = await baseRepo();
      await prMerge(root, async (r) => {
        if (path === "docs") await rm(join(r, "docs"), { recursive: true, force: true });
        await put(r, path, "new\n");
      });
      expect(await expectScope(root, false), path).toContain("full CI");
    }
  });

  it("a rename from src into docs => false (both sides are checked)", async () => {
    const root = await baseRepo();
    await prMerge(root, async (r) => { await git(r, "mv", "src/cli.ts", "docs/cli.ts"); });
    expect(await expectScope(root, false)).toContain("src/cli.ts");
  });

  it("a docs/../src path trick lands on src and => false", async () => {
    const root = await baseRepo();
    await prMerge(root, async (r) => { await put(r, "docs/../src/evil.ts", "new\n"); });
    expect(await expectScope(root, false)).toContain("src/evil.ts");
  });

  it("filenames with spaces are matched whole: docs => true, src => false", async () => {
    const docs = await baseRepo();
    await prMerge(docs, async (r) => { await put(r, "docs/my notes.md", "new\n"); });
    expect(await expectScope(docs, true)).toContain("docs/my notes.md");

    const src = await baseRepo();
    await prMerge(src, async (r) => { await put(r, "docs/a b.md", "new\n"); await put(r, "src/a b.ts", "new\n"); });
    expect(await expectScope(src, false)).toContain("src/a b.ts");
  });

  it.skipIf(process.platform === "win32")("a newline in a docs filename cannot smuggle in a second path => false", async () => {
    const root = await baseRepo();
    await prMerge(root, async (r) => { await put(r, "docs/a.md\nsrc/cli.ts", "new\n"); });
    await expectScope(root, false);
  });

  it.skipIf(process.platform === "win32")("a symlink under docs => false", async () => {
    const root = await baseRepo();
    await prMerge(root, async (r) => { await symlink("../src/cli.ts", join(r, "docs", "link.md")); });
    expect(await expectScope(root, false)).toContain("mode");
  });

  it("outside a git repository => false, exit 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-ci-scope-nogit-")); temporary.push(root);
    await copyFile(realScript, join(root, "ci-scope.sh"));
    await expectScope(root, false, { ...PR_ENV, GIT_CEILING_DIRECTORIES: dirname(root) });
  });
});
