import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { socketPath } from "../src/daemon.js";
import { assertSafeAncestry, credentialPath, headroomHome, vendorHome } from "../src/paths.js";
import { installService, serviceContents, servicePath, uninstallService, windowsTaskXml } from "../src/service.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

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

describe("HEADROOM_HOME ancestor safety", () => {
  it("accepts an ordinary 0755 ancestor, like a real home directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-ancestry-0755-")); temporary.push(root);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o755 });
    await chmod(home, 0o755);
    await expect(assertSafeAncestry(join(home, ".headroom"))).resolves.toBeUndefined();
  });

  it("accepts a world-writable ancestor only when the sticky bit is set, like /tmp", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-ancestry-sticky-")); temporary.push(root);
    const sticky = join(root, "sticky");
    await mkdir(sticky, { mode: 0o1777 });
    await chmod(sticky, 0o1777);
    await expect(assertSafeAncestry(join(sticky, ".headroom"))).resolves.toBeUndefined();
  });

  it("refuses a world-writable ancestor with no sticky bit", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-ancestry-worldwritable-")); temporary.push(root);
    const loose = join(root, "loose");
    await mkdir(loose, { mode: 0o777 });
    await chmod(loose, 0o777); // belt and suspenders: mkdir's mode is umask-masked too
    await expect(assertSafeAncestry(join(loose, ".headroom"))).rejects.toThrow("group or world writable without the sticky bit");
  });

  it("refuses an ancestor owned by another user", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-ancestry-otheruser-")); temporary.push(root);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o755 });
    await expect(assertSafeAncestry(join(home, ".headroom"), { uid: (process.getuid?.() ?? 0) + 1 })).rejects.toThrow("is owned by another user");
  });

  it("resolves a real ancestor chain (root through mktemp) with no false refusal", async () => {
    // A regression lock for the exact scripts/smoke-cold.sh shape: an ordinary
    // 0755 $HOME whose ancestor chain may itself cross a system alias
    // (macOS's /var -> /private/var under a default TMPDIR).
    const root = await mkdtemp(join(tmpdir(), "headroom-ancestry-real-")); temporary.push(root);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o755 });
    await expect(assertSafeAncestry(join(home, ".headroom"))).resolves.toBeUndefined();
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
    expect(serviceContents("cli.js", "win32", "node.exe", "alice", "C:\\Users\\alice", { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" })).toContain('daemon.log');
    expect(serviceContents("cli.js", "win32", "node.exe", "alice", "C:\\Users\\alice", { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" })).toContain('PATH=C:\\Users\\alice\\.local\\bin');
  });

  it("keeps a complete systemd user unit", async () => {
    const result = await installService("/usr/bin/headroom", "linux", "/home/alice", "/usr/bin/node", true);
    expect(result.command).toBe("systemctl --user enable --now headroom.service");
    const unit = serviceContents("/usr/bin/headroom", "linux", "/usr/bin/node", "alice", "/home/alice");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("StandardOutput=append:/home/alice/.headroom/logs/daemon.log");
    expect(unit).toContain('Environment="PATH=/home/alice/.local/bin:/opt/homebrew/bin');
    const plist = serviceContents("/usr/bin/headroom", "darwin", "/usr/bin/node", "alice", "/Users/alice");
    expect(plist).toContain("<key>StandardOutPath</key><string>/Users/alice/.headroom/logs/daemon.log</string>");
    expect(plist).toContain("<key>StandardErrorPath</key><string>/Users/alice/.headroom/logs/daemon.log</string>");
    expect(plist).toContain("<key>EnvironmentVariables</key><dict><key>PATH</key><string>/Users/alice/.local/bin:/opt/homebrew/bin");
  });
});
