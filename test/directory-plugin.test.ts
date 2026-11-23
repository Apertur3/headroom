import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// plugin/ is the code-free plugin submitted to the Claude plugin directory. Its skill is the root skill with only the
// setup section swapped (it may not install anything), so the rest must not drift from skills/headroom/SKILL.md.
const outsideSetup = (path: string) => readFileSync(path, "utf8").replace(/## Setting Headroom up[\s\S]*?(?=## Keep the budget in sight)/, "");

describe("directory plugin", () => {
  it("keeps its skill in step with the root skill apart from setup", () => {
    expect(outsideSetup("plugin/skills/headroom/SKILL.md")).toBe(outsideSetup("skills/headroom/SKILL.md"));
  });
  it("never tells the agent to install anything", () => {
    expect(readFileSync("plugin/skills/headroom/SKILL.md", "utf8")).not.toMatch(/npm install|brew install|curl /);
  });
});
