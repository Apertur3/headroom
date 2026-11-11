/** A long-lived MCP process that outlives an upgrade says "reconnect" on a failed tool call. */
import { describe, expect, it } from "vitest";
import { headroomVersion, staleProcessHint } from "../src/version.js";

describe("staleProcessHint", () => {
  it("is empty while the installed version matches the running one", async () => {
    expect(await staleProcessHint(await headroomVersion())).toBe("");
    expect(await staleProcessHint("unknown")).toBe("");
  });
  it("names both versions and /mcp once a different version is installed", async () => {
    const hint = await staleProcessHint("999.0.0");
    expect(hint).toContain("999.0.0 is installed");
    expect(hint).toContain(`still runs ${await headroomVersion()}`);
    expect(hint).toContain("/mcp");
  });
});
