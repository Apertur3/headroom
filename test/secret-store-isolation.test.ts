import { execFile } from "node:child_process";
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

  it("still runs ordinary commands", async () => {
    expect((await systemRunner(process.execPath, ["-e", "process.stdout.write('ok')"])).trim()).toBe("ok");
  });
});
