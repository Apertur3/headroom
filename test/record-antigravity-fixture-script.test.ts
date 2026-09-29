import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = join(__dirname, "..", "scripts", "record-antigravity-fixture.sh");

// Dry-run only: never builds the engine and never invokes it (so never touches agy).
describe("record-antigravity-fixture.sh", () => {
  it("prints the engine command and stops before invoking it", async () => {
    const { stdout } = await execFileAsync("bash", [script, "--dry-run", "gemini-weekly-exhausted"]);
    expect(stdout).toMatch(/observe --principals <temp principals json> --record test\/fixtures\/antigravity\/\d{4}-\d{2}-\d{2}-gemini-weekly-exhausted\.json/);
  });

  it("rejects a label that is not kebab-case", async () => {
    await expect(execFileAsync("bash", [script, "--dry-run", "../escape"])).rejects.toMatchObject({ code: 2 });
  });
});
