import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { migrateLegacyHome } from "../src/paths.js";

const execFileAsync = promisify(execFile);

describe("brand identity", () => {
  it("has no retired brand text outside the changelog", async () => {
    const retired = `(${["ta", "lly"].join("")}|${["keep", "ta", "lly"].join("")})`;
    try {
      const { stdout } = await execFileAsync("rg", ["-l", "-i", retired, "--glob", "!CHANGELOG.md", "."]);
      expect(stdout.trim()).toBe("");
    } catch (error: unknown) {
      const result = error as { code?: number; stdout?: string };
      if (result.code === 1) return;
      throw error;
    }
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
});
