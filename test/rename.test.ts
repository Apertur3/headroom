import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { migrateLegacyHome } from "../src/paths.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("brand identity", () => {
  it("has no retired brand text outside the changelog", async () => {
    // No external binary (ripgrep is not guaranteed on CI runners, and this
    // must also pass on Windows without shell quoting or /dev/null): walk the
    // files git actually tracks and grep them in Node instead. Word-boundary
    // wrapped: an ordinary English adverb ending the same way the retired
    // name is spelled must not false-positive as leftover brand text (it
    // tripped this exact check on README.md's "experimentally").
    const retired = new RegExp(`\\b(${["ta", "lly"].join("")}|${["keep", "ta", "lly"].join("")})\\b`, "i");
    const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    const files = stdout.split("\n").map((line) => line.trim()).filter((line) => line && line !== "CHANGELOG.md");
    const offenders: string[] = [];
    for (const file of files) {
      let content: string;
      try { content = await readFile(join(repoRoot, file), "utf8"); }
      catch { continue; } // gone, unreadable, or not a regular file: nothing to scan
      if (retired.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("moves the prior state directory only when the replacement is absent", async () => {
    const root = join(tmpdir(), `headroom-migration-${Date.now()}-${Math.random()}`);
    const retired = join(root, [".", "ta", "lly"].join(""));
    try {
      await mkdir(retired, { recursive: true });
      expect(await migrateLegacyHome({ platform: "darwin", home: root, env: {} })).toBe(true);
      expect(await migrateLegacyHome({ platform: "darwin", home: root, env: {} })).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("moves the prior engine cache when the new home was created first", async () => {
    const root = join(tmpdir(), `headroom-engine-migration-${Date.now()}-${Math.random()}`);
    const retired = join(root, [".", "ta", "lly"].join(""));
    const current = join(root, ".headroom");
    try {
      await mkdir(join(retired, "engine", "v0.56.4"), { recursive: true });
      await writeFile(join(retired, "engine", "v0.56.4", "codexbar"), "pinned engine");
      await mkdir(current, { recursive: true });
      expect(await migrateLegacyHome({ platform: "darwin", home: root, env: {} })).toBe(true);
      expect(await readFile(join(current, "engine", "v0.56.4", "codexbar"), "utf8")).toBe("pinned engine");
      expect(await migrateLegacyHome({ platform: "darwin", home: root, env: {} })).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
