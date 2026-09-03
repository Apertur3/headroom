import { describe, expect, it } from "vitest";
import { socketPath } from "../src/daemon.js";
import { credentialPath, tallyHome, vendorHome } from "../src/paths.js";
import { installService, serviceContents, servicePath, uninstallService, windowsTaskXml } from "../src/service.js";

describe("cross-platform paths", () => {
  it("resolves Tally and vendor locations for macOS, Linux, and Windows", () => {
    expect(tallyHome({ platform: "darwin", home: "/Users/alice", env: {} })).toBe("/Users/alice/.tally");
    expect(tallyHome({ platform: "linux", home: "/home/alice", env: {} })).toBe("/home/alice/.tally");
    expect(tallyHome({ platform: "win32", home: "C:\\Users\\alice", env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" } })).toBe("C:\\Users\\alice\\AppData\\Local\\keeptally");
    expect(tallyHome({ platform: "win32", home: "C:\\Users\\alice", env: { TALLY_HOME: "D:\\tally" } })).toBe("D:\\tally");
    expect(vendorHome("codex", { platform: "win32", home: "C:\\Users\\alice", env: {} })).toBe("C:\\Users\\alice\\.codex");
    expect(credentialPath("claude", undefined, { platform: "linux", home: "/home/alice", env: {} })).toBe("/home/alice/.claude/.credentials.json");
    expect(credentialPath("codex", undefined, { platform: "win32", home: "C:\\Users\\alice", env: {} })).toBe("C:\\Users\\alice\\.codex\\auth.json");
    expect(credentialPath("antigravity", undefined, { platform: "darwin", home: "/Users/alice", env: {} })).toBe("/Users/alice/.gemini/oauth_creds.json");
  });

  it("uses a per-user named pipe on Windows", () => {
    expect(socketPath("ignored", "win32", "alice")).toBe("\\\\.\\pipe\\keeptally-alice");
    expect(socketPath("/home/alice", "linux", "alice")).toBe("/home/alice/tally.sock");
  });
});

describe("service generators", () => {
  it("generates the expected Windows logon task and commands", async () => {
    const xml = windowsTaskXml("C:\\Program Files\\keeptally\\cli.js", "C:\\Program Files\\nodejs\\node.exe", "alice");
    expect(xml).toContain("<LogonTrigger><Enabled>true</Enabled></LogonTrigger>");
    expect(xml).toContain("<Hidden>true</Hidden>");
    expect(xml).toContain("<UserId>alice</UserId>");
    expect(servicePath("win32", "C:\\Users\\alice", { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" })).toBe("C:\\Users\\alice\\AppData\\Local\\keeptally\\keeptally-daemon.xml");
    await expect(installService("cli.js", "win32", "C:\\Users\\alice", "node.exe", true, { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" }, "alice")).resolves.toMatchObject({ dryRun: true, command: 'schtasks /Create /TN "Keeptally Daemon" /XML "C:\\Users\\alice\\AppData\\Local\\keeptally\\keeptally-daemon.xml" /F' });
    await expect(uninstallService("win32", "C:\\Users\\alice", true, { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" })).resolves.toMatchObject({ dryRun: true, command: 'schtasks /Delete /TN "Keeptally Daemon" /F' });
  });

  it("keeps a complete systemd user unit", async () => {
    const result = await installService("/usr/bin/tally", "linux", "/home/alice", "/usr/bin/node", true);
    expect(result.command).toBe("systemctl --user enable --now keeptally-daemon.service");
    expect(serviceContents("/usr/bin/tally", "linux", "/usr/bin/node")).toContain("WantedBy=default.target");
  });
});
