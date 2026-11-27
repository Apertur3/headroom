import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { observeKimi } from "../src/adapters/kimi.js";
import { readSecret, systemRunner } from "../src/notify.js";

// setup-isolation.ts refuses every secret-store command. If that ever stops
// working, these fail before any other test can read a real Keychain item.
describe("secret store isolation", () => {
  it("refuses security, secret-tool and the Credential Manager read at the execFile seam", async () => {
    await expect(systemRunner("security", ["find-generic-password", "-a", "headroom", "-s", "headroom-moonshot", "-w"])).rejects.toThrow(/blocked in tests/);
    await expect(systemRunner("/usr/bin/security", ["find-generic-password"])).rejects.toThrow(/blocked in tests/);
    await expect(systemRunner("secret-tool", ["lookup", "service", "headroom-webhook"])).rejects.toThrow(/blocked in tests/);
    await expect(promisify(execFile)("powershell", ["-Command", "CredReadW"])).rejects.toThrow(/blocked in tests/);
    const callback = await new Promise<Error | null>((done) => execFile("security", ["find-generic-password"], (error) => done(error)));
    expect(callback?.message).toMatch(/blocked in tests/);
  });

  it("keeps every default path away from the real store: readSecret, and the Kimi credits read with no runner", async () => {
    for (const platform of ["darwin", "linux"] as const) expect((await readSecret("headroom-moonshot", { platform })).secret).toBeUndefined();
    let calls = 0;
    const fetcher = (async () => { calls += 1; return new Response("{}"); }) as unknown as typeof fetch;
    const rows = await observeKimi({ name: "kimi", vendor: "kimi", location: "/nonexistent/auth.token", adapter: "native-ts" }, { fetch: fetcher, platform: "darwin" });
    expect(rows.some((row) => row.meter_id === "kimi:credits")).toBe(false);
    expect(calls).toBe(0);
  });

  it.skipIf(process.platform === "win32")("skips a directory or non-executable fake the way the OS does, and runs only the exact fake path", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-fake-store-"));
    const previous = process.env.PATH;
    try {
      const [folder, plain, fake] = ["folder", "plain", "fake"].map((name) => join(root, name));
      await mkdir(join(folder, "security"), { recursive: true });
      await mkdir(plain); await writeFile(join(plain, "security"), "#!/bin/sh\necho plain\n", { mode: 0o644 });
      await mkdir(fake); await writeFile(join(fake, "security"), "#!/bin/sh\necho fake\n"); await chmod(join(fake, "security"), 0o755);
      // Only a directory and a non-executable file under the temp dir, then
      // the system directories: the OS would run the machine's own tool.
      process.env.PATH = [folder, plain, "/usr/bin", "/bin"].join(delimiter);
      await expect(systemRunner("security", ["find-generic-password"])).rejects.toThrow(/blocked in tests/);
      process.env.PATH = [folder, plain, fake, "/usr/bin"].join(delimiter);
      expect((await systemRunner("security", ["find-generic-password"])).trim()).toBe("fake");
    } finally { process.env.PATH = previous; await rm(root, { recursive: true, force: true }); }
  });

  it("still runs ordinary commands", async () => {
    expect((await systemRunner(process.execPath, ["-e", "process.stdout.write('ok')"])).trim()).toBe("ok");
  });
});
