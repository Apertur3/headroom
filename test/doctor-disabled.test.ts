import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctorChecks } from "../src/doctor.js";
import { useTemporary } from "./helpers/common.js";

const temporary = useTemporary();

describe("doctor disabled principal", () => {
  it("reports one INFO line and includes the disabled count instead of credential or adapter failures", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-doctor-disabled-")); temporary.push(home);
    await writeFile(join(home, "accounts.toml"), ['[[accounts]]', 'name = "claude-2"', 'enabled = false', 'vendor = "claude"', 'location = "/fixture/.claude2"', 'adapter = "native-ts"', ''].join("\n"), { mode: 0o600 });
    const previous = process.env.HEADROOM_HOME; process.env.HEADROOM_HOME = home;
    try {
      const checks = await doctorChecks();
      expect(checks.find((item) => item.check === "principals")).toMatchObject({ detail: expect.stringContaining("1 configured, 1 disabled") });
      expect(checks.filter((item) => item.check.startsWith("principal claude-2"))).toEqual([expect.objectContaining({ level: "INFO", detail: "disabled in accounts.toml, not polled" })]);
    } finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
  });
});
