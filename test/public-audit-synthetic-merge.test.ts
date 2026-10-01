import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);
const realScript = join(__dirname, "..", "scripts", "public-audit.sh");
const NOREPLY = "1+dev@users.noreply.github.com";
const PERSONAL = "someone@example.com";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function git(cwd: string, email: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "dev", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "dev", GIT_COMMITTER_EMAIL: email,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return stdout.trim();
}

/** A throwaway repo holding the real script and one noreply commit on main. */
async function fakeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headroom-public-audit-")); temporary.push(root);
  await mkdir(join(root, "scripts"));
  await copyFile(realScript, join(root, "scripts", "public-audit.sh"));
  await git(root, NOREPLY, "init", "-q", "-b", "main");
  await git(root, NOREPLY, "add", ".");
  await git(root, NOREPLY, "commit", "-q", "-m", "base");
  return root;
}

/** Branch off, add a noreply commit on both sides, then merge as `email` with the given subject. */
async function mergeOnTop(root: string, email: string, subject: (a: string, b: string) => string): Promise<void> {
  await git(root, NOREPLY, "checkout", "-q", "-b", "pr");
  await git(root, NOREPLY, "commit", "-q", "--allow-empty", "-m", "pr work");
  await git(root, NOREPLY, "checkout", "-q", "main");
  await git(root, NOREPLY, "commit", "-q", "--allow-empty", "-m", "main work");
  const main = await git(root, NOREPLY, "rev-parse", "HEAD");
  const pr = await git(root, NOREPLY, "rev-parse", "pr");
  await git(root, email, "merge", "-q", "--no-ff", "pr", "-m", subject(pr, main));
}

async function audit(root: string, event: string | undefined): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, PRIVACY_DENYLIST: join(root, "none"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  delete env.GITHUB_EVENT_NAME;
  if (event) env.GITHUB_EVENT_NAME = event;
  return execFileAsync("bash", [join(root, "scripts", "public-audit.sh")], { cwd: root, env })
    .then(({ stdout, stderr }) => stdout + stderr, (e: { stdout: string; stderr: string }) => e.stdout + e.stderr);
}

const synthetic = (pr: string, main: string): string => `Merge ${pr} into ${main}`;

describe("public-audit check 2 and GitHub's synthetic PR merge commit", () => {
  it("ignores a personal-email synthetic merge under pull_request", async () => {
    const root = await fakeRepo();
    await mergeOnTop(root, PERSONAL, synthetic);
    expect(await audit(root, "pull_request")).not.toContain("personal email");
  });

  it("flags the same commit when not a pull_request run", async () => {
    const root = await fakeRepo();
    await mergeOnTop(root, PERSONAL, synthetic);
    expect(await audit(root, undefined)).toContain("personal email in commit metadata");
  });

  it("still flags a real personal-email commit under pull_request", async () => {
    const root = await fakeRepo();
    await git(root, PERSONAL, "commit", "-q", "--allow-empty", "-m", "real work");
    expect(await audit(root, "pull_request")).toContain("personal email in commit metadata");
  });

  it("still flags a normal maintainer merge commit under pull_request", async () => {
    const root = await fakeRepo();
    await mergeOnTop(root, PERSONAL, () => "Merge branch 'pr'");
    expect(await audit(root, "pull_request")).toContain("personal email in commit metadata");
  });

  it("still flags a personal-email commit hiding under a synthetic merge", async () => {
    const root = await fakeRepo();
    await git(root, PERSONAL, "commit", "-q", "--allow-empty", "-m", "real work");
    await mergeOnTop(root, PERSONAL, synthetic);
    expect(await audit(root, "pull_request")).toContain("personal email in commit metadata");
  });
});
