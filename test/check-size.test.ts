import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-size.mjs");
const temporary: string[] = [];
afterEach(() => { temporary.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function check(files: Record<string, string>, caps: Record<string, number> = {}) {
  const root = mkdtempSync(join(tmpdir(), "headroom-size-")); temporary.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [file, text] of Object.entries({ ...files, "size-ratchet.json": JSON.stringify(caps) })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

describe("size gate", () => {
  it("warns above 400 and fails above 1000, counting an unterminated last line", () => {
    expect(check({ "src/example.ts": "\n".repeat(400) }).stderr).toBe("");
    const warning = check({ "src/example.ts": "\n".repeat(400) + "// last" });
    expect(warning.status).toBe(0);
    expect(warning.stderr).toContain("401 lines exceeds 400");
    expect(check({ "src/example.ts": "\n".repeat(1000) }).status).toBe(0);
    const failure = check({ "src/example.ts": "\n".repeat(1000) + "// last" });
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain("1001 lines exceeds cap 1000");
  });

  it("requires exact caps and removes entries once files reach 1000 lines", () => {
    const files = { "test/example.ts": "\n".repeat(1001) };
    expect(check(files, { "test/example.ts": 1001 }).status).toBe(0);
    expect(check(files, { "test/example.ts": 1000 }).status).toBe(1);
    const stale = check(files, { "test/example.ts": 1002 });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("Refresh ratchet");
    expect(check({ "test/example.ts": "\n".repeat(1000) }, { "test/example.ts": 1001 }).status).toBe(1);
    expect(check({}, { "src/missing.ts": 1001 }).status).toBe(1);
    expect(check(files, { "test/example.ts": 1001.5 }).status).toBe(1);
  });

  it.each(["ts", "mjs", "js", "sh"])("checks untracked .%s files", (extension) => {
    expect(check({ [`scripts/example.${extension}`]: "\n".repeat(1001) }).status).toBe(1);
  });

  it("exempts only the generated files and ignores gitignored files", () => {
    const oversized = "\n".repeat(1001);
    const result = check({
      ".gitignore": "ignored.js\n",
      "ignored.js": oversized,
      "src/pace-core.ts": oversized,
      "src/browser-report-fonts.ts": oversized,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(check({ "src/other.ts": "// GENERATED\n" + oversized }).status).toBe(1);
  });

  it("warns for functions above 100 lines without failing", () => {
    const result = check({ "src/example.js": `function example() {\n${"\n".repeat(99)}}\n` });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("src/example.js:1: function exceeds 100 lines");
    expect(check({ "src/example.ts": `const example = () => {\n${"\n".repeat(98)}};\n` }).stderr).toBe("");
  });
});
