import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctorFileStatus } from "../src/doctor.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("doctor file checks", () => {
  it("accepts normal 0644 config files and service-created logs instead of calling them absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-doctor-")); temporary.push(root);
    const file = join(root, "policy.toml");
    await writeFile(file, "poll_interval_minutes = 5\n", { mode: 0o644 });
    await chmod(file, 0o644);
    await expect(doctorFileStatus(file)).resolves.toBe("present");
    await expect(doctorFileStatus(join(root, "missing.log"))).resolves.toBe("missing");
  });
});
