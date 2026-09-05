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

async function checkFile(contents: string): Promise<{ code: number; stdout: string }> {
  const root = await mkdtemp(join(tmpdir(), "headroom-privacy-sweep-"));
  temporary.push(root);
  const target = join(root, "fixture.txt");
  await writeFile(target, contents, "utf8");
  try {
    const { stdout } = await execFileAsync("bash", [scriptPath, "--check", target]);
    return { code: 0, stdout };
  } catch (error: unknown) {
    const result = error as { code?: number; stdout?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? "" };
  }
}

describe("scripts/privacy-sweep.sh --check", () => {
  it("fails on a private IPv4 address", async () => {
    const { code, stdout } = await checkFile("internal box at 192.168.1.50 for testing\n");
    expect(code).not.toBe(0);
    expect(stdout).toContain("private IPv4 address");
  });

  it("fails on each private range: 10.x, 192.168.x, 172.16-31.x, and 100.64.x", async () => {
    for (const ip of ["10.1.2.3", "192.168.0.9", "172.20.5.5", "192.0.2.5"]) {
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
    const real = await checkFile("contact owner@gmail.com for help\n");
    expect(real.code).not.toBe(0);
    expect(real.stdout).toContain("email address");
    const documented = await checkFile("contact owner@example.com for help\n");
    expect(documented.code).toBe(0);
  });

  it("fails on a home path with a real username, but not an allowed placeholder", async () => {
    const real = await checkFile("wrote /Users/johndoe/.headroom/accounts.toml\n");
    expect(real.code).not.toBe(0);
    expect(real.stdout).toContain("real username");
    const placeholder = await checkFile("wrote /Users/you/.headroom/accounts.toml\n");
    expect(placeholder.code).toBe(0);
  });

  it("fails on a denylist match (case-insensitive)", async () => {
    const { code, stdout } = await checkFile("deployed to gpu-box last night\n");
    expect(code).not.toBe(0);
    expect(stdout).toContain("denylist match");
  });

  it("passes a clean file", async () => {
    const { code } = await checkFile("nothing sensitive here at all\n");
    expect(code).toBe(0);
  });
});
