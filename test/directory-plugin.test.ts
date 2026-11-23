import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// plugin/ is the code-free plugin listed in the Claude plugin directory. The directory refuses text that installs
// software or tells Claude or the user to add an MCP server the plugin does not declare, so plugin/ must use the
// headroom CLI only.
const texts = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && /\.(md|json)$/.test(entry.name))
  .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));

describe("directory plugin", () => {
  it("never mentions MCP or tells anyone to install something", () => {
    for (const text of texts("plugin")) expect(text).not.toMatch(/\bmcp\b|quota_|npm install|brew install|curl /i);
  });
});
