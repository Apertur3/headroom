import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialCheck } from "../src/doctor.js";
import { installService, serviceContents, serviceFileBytes } from "../src/service.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("windows service file: schtasks only accepts UTF-16 task XML", () => {
  it("declares and writes UTF-16LE with a byte-order mark on win32, plain UTF-8 elsewhere", () => {
    const xml = serviceContents("C:\\h\\cli.js", "win32", "C:\\node\\node.exe", "tester", "C:\\Users\\tester", { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
    const bytes = serviceFileBytes("win32", xml);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe(xml);
    expect(serviceFileBytes("linux", "abc").toString("utf8")).toBe("abc");
  });

  it("installService writes the file as UTF-16LE for win32", async () => {
    const home = await mkdtemp(join(tmpdir(), "headroom-win-"));
    temporary.push(home);
    // A win32 path on a posix host is a stray backslash-named file in the cwd; point it into the temp dir instead.
    const env = { LOCALAPPDATA: home, HEADROOM_HOME: home };
    const result = await installService("C:\\h\\cli.js", "win32", home, "C:\\node\\node.exe", false, env, "tester");
    temporary.push(result.path);
    const bytes = await readFile(result.path);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
  });
});

describe("claude credential file without a login (issue seen on a fresh Windows user)", () => {
  it("doctor does not call a credential file OK when it only holds MCP tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "headroom-cred-"));
    temporary.push(dir);
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({ mcpOAuth: { "plugin:x|1": { accessToken: "t" } } }), { mode: 0o600 });
    const result = await credentialCheck({ name: "claude-main", vendor: "claude", location: dir, adapter: "native-ts" } as never, new Map(), undefined);
    if (process.platform === "darwin") return; // macOS reads the Keychain, not this file
    expect(result.level).toBe("FAIL");
    expect(result.fix).toContain("claude");
  });

  it("still reports OK when a claudeAiOauth token is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "headroom-cred-"));
    temporary.push(dir);
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: 1 } }), { mode: 0o600 });
    const result = await credentialCheck({ name: "claude-main", vendor: "claude", location: dir, adapter: "native-ts" } as never, new Map(), undefined);
    if (process.platform === "darwin") return;
    expect(result.level).toBe("OK");
  });
});

describe("keychain grant off macOS", () => {
  it("says there is nothing to grant instead of asking for a probe build", async () => {
    const { keychain } = await import("../src/cli.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(await keychain(["grant"])).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toContain("Nothing to grant on this platform");
    } finally { platform.mockRestore(); log.mockRestore(); }
  });
});
