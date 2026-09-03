import { describe, expect, it } from "vitest";
import { socketPath } from "../src/daemon.js";
import { credentialPath, headroomHome, vendorHome } from "../src/paths.js";
import { installService, serviceContents, servicePath, uninstallService, windowsTaskXml } from "../src/service.js";

describe("cross-platform paths", () => {
  it("resolves Headroom and vendor locations for macOS, Linux, and Windows", () => {
    expect(headroomHome({ platform: "darwin", home: "/Users/alice", env: {} })).toBe("/Users/alice/.headroom");
    expect(headroomHome({ platform: "linux", home: "/home/alice", env: {} })).toBe("/home/alice/.headroom");
    expect(headroomHome({ platform: "win32", home: "C:\\Users\\alice", env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" } })).toBe("C:\\Users\\alice\\AppData\\Local\\headroom");
    expect(headroomHome({ platform: "win32", home: "C:\\Users\\alice", env: { HEADROOM_HOME: "D:\\headroom" } })).toBe("D:\\headroom");
    expect(vendorHome("codex", { platform: "win32", home: "C:\\Users\\alice", env: {} })).toBe("C:\\Users\\alice\\.codex");
    expect(credentialPath("claude", undefined, { platform: "linux", home: "/home/alice", env: {} })).toBe("/home/alice/.claude/.credentials.json");
    expect(credentialPath("codex", undefined, { platform: "win32", home: "C:\\Users\\alice", env: {} })).toBe("C:\\Users\\alice\\.codex\\auth.json");
    expect(credentialPath("antigravity", undefined, { platform: "darwin", home: "/Users/alice", env: {} })).toBe("/Users/alice/.gemini/oauth_creds.json");
  });

  it("uses a per-user named pipe on Windows", () => {
    expect(socketPath("ignored", "win32", "alice")).toBe("\\\\.\\pipe\\headroom-alice");
    expect(socketPath("/home/alice", "linux", "alice")).toBe("/home/alice/headroom.sock");
  });
});

describe("service generators", () => {
  it("generates the expected Windows logon task and commands", async () => {
    const xml = windowsTaskXml("C:\\Program Files\\headroom\\cli.js", "C:\\Program Files\\nodejs\\node.exe", "alice");
    expect(xml).toContain("<LogonTrigger><Enabled>true</Enabled></LogonTrigger>");
    expect(xml).toContain("<Hidden>true</Hidden>");
    expect(xml).toContain("<UserId>alice</UserId>");
    expect(servicePath("win32", "C:\\Users\\alice", { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" })).toBe("C:\\Users\\alice\\AppData\\Local\\headroom\\headroom-daemon.xml");
    await expect(installService("cli.js", "win32", "C:\\Users\\alice", "node.exe", true, { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" }, "alice")).resolves.toMatchObject({ dryRun: true, command: 'schtasks /Create /TN "Headroom Daemon" /XML "C:\\Users\\alice\\AppData\\Local\\headroom\\headroom-daemon.xml" /F' });
    await expect(uninstallService("win32", "C:\\Users\\alice", true, { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" })).resolves.toMatchObject({ dryRun: true, command: 'schtasks /Delete /TN "Headroom Daemon" /F' });
  });

  it("keeps a complete systemd user unit", async () => {
    const result = await installService("/usr/bin/headroom", "linux", "/home/alice", "/usr/bin/node", true);
    expect(result.command).toBe("systemctl --user enable --now headroom.service");
    expect(serviceContents("/usr/bin/headroom", "linux", "/usr/bin/node")).toContain("WantedBy=default.target");
  });
});
