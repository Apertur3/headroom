import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { socketPath } from "../src/daemon.js";
import { assertSafeAncestry, credentialPath, headroomHome, vendorHome } from "../src/paths.js";
import { installService, serviceContents, servicePath, uninstallService, windowsTaskXml } from "../src/service.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("cross-platform paths", () => {
  it("resolves Headroom and vendor locations for macOS, Linux, and Windows", () => {
    expect(headroomHome({ platform: "darwin", home: "/Users/example", env: {} })).toBe("/Users/example/.headroom");
    expect(headroomHome({ platform: "linux", home: "/home/example", env: {} })).toBe("/home/example/.headroom");
    expect(headroomHome({ platform: "win32", home: "C:\\Users\\example", env: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" } })).toBe("C:\\Users\\example\\AppData\\Local\\headroom");
    expect(headroomHome({ platform: "win32", home: "C:\\Users\\example", env: { HEADROOM_HOME: "D:\\headroom" } })).toBe("D:\\headroom");
    expect(vendorHome("codex", { platform: "win32", home: "C:\\Users\\example", env: {} })).toBe("C:\\Users\\example\\.codex");
    expect(credentialPath("claude", undefined, { platform: "linux", home: "/home/example", env: {} })).toBe("/home/example/.claude/.credentials.json");
    expect(credentialPath("codex", undefined, { platform: "win32", home: "C:\\Users\\example", env: {} })).toBe("C:\\Users\\example\\.codex\\auth.json");
    expect(credentialPath("antigravity", undefined, { platform: "darwin", home: "/Users/example", env: {} })).toBe("/Users/example/.gemini/oauth_creds.json");
  });

  it("uses a per-user named pipe on Windows", () => {
    expect(socketPath("ignored", "win32", "example")).toBe("\\\\.\\pipe\\headroom-example");
    expect(socketPath("/home/example", "linux", "example")).toBe("/home/example/headroom.sock");
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
    if (process.platform === "win32") {
      // Windows has no POSIX mode bits to inspect; assertSafeAncestry itself
      // skips this check for platform "win32" (see its `continue` on the
      // writable-without-sticky test), so there is nothing to refuse here.
      await expect(assertSafeAncestry(join(loose, ".headroom"))).resolves.toBeUndefined();
      return;
    }
    await expect(assertSafeAncestry(join(loose, ".headroom"))).rejects.toThrow("group or world writable without the sticky bit");
  });

  it("refuses an ancestor owned by another user", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-ancestry-otheruser-")); temporary.push(root);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o755 });
    if (process.platform === "win32") {
      // fs.Stats.uid is always 0 on Windows (there is no real POSIX uid to
      // read), so there is no ownership to compare against a synthetic
      // "other user" -- assertSafeAncestry has no meaningful uid model here
      // even when a caller forces its way past the "no uid at all" early
      // return by passing an explicit uid, as this test does.
      await expect(assertSafeAncestry(join(home, ".headroom"), { uid: (process.getuid?.() ?? 0) + 1 })).resolves.toBeUndefined();
      return;
    }
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
    const xml = windowsTaskXml("C:\\Program Files\\headroom\\cli.js", "C:\\Program Files\\nodejs\\node.exe", "example");
    expect(xml).toContain("<LogonTrigger><Enabled>true</Enabled></LogonTrigger>");
    expect(xml).toContain("<Hidden>true</Hidden>");
    expect(xml).toContain("<UserId>example</UserId>");
    expect(servicePath("win32", "C:\\Users\\example", { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" })).toBe("C:\\Users\\example\\AppData\\Local\\headroom\\headroom-daemon.xml");
    await expect(installService("cli.js", "win32", "C:\\Users\\example", "node.exe", true, { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" }, "example")).resolves.toMatchObject({ dryRun: true, command: 'schtasks /Create /TN "Headroom Daemon" /XML "C:\\Users\\example\\AppData\\Local\\headroom\\headroom-daemon.xml" /F' });
    await expect(uninstallService("win32", "C:\\Users\\example", true, { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" })).resolves.toMatchObject({ dryRun: true, command: 'schtasks /Delete /TN "Headroom Daemon" /F' });
    expect(serviceContents("cli.js", "win32", "node.exe", "example", "C:\\Users\\example", { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" })).toContain('daemon.log');
    expect(serviceContents("cli.js", "win32", "node.exe", "example", "C:\\Users\\example", { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" })).toContain('PATH=C:\\Users\\example\\.local\\bin');
  });

  it("keeps a complete systemd user unit", async () => {
    const result = await installService("/usr/bin/headroom", "linux", "/home/example", "/usr/bin/node", true);
    expect(result.command).toBe("systemctl --user enable --now headroom.service");
    const unit = serviceContents("/usr/bin/headroom", "linux", "/usr/bin/node", "example", "/home/example");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("StandardOutput=append:/home/example/.headroom/logs/daemon.log");
    expect(unit).toContain('Environment="PATH=/home/example/.local/bin:/opt/homebrew/bin');
    const plist = serviceContents("/usr/bin/headroom", "darwin", "/usr/bin/node", "example", "/Users/example");
    expect(plist).toContain("<key>StandardOutPath</key><string>/Users/example/.headroom/logs/daemon.log</string>");
    expect(plist).toContain("<key>StandardErrorPath</key><string>/Users/example/.headroom/logs/daemon.log</string>");
    expect(plist).toContain("<key>EnvironmentVariables</key><dict><key>PATH</key><string>/Users/example/.local/bin:/opt/homebrew/bin");
  });

  it("a --dry-run install carries the full unit/plist/task text it would have written, on all three platforms", async () => {
    const linux = await installService("/usr/bin/headroom", "linux", "/home/example", "/usr/bin/node", true);
    expect(linux.contents).toBe(serviceContents("/usr/bin/headroom", "linux", "/usr/bin/node", userInfo().username, "/home/example"));
    expect(linux.contents).toContain("[Unit]");

    const darwin = await installService("/usr/bin/headroom", "darwin", "/Users/example", "/usr/bin/node", true);
    expect(darwin.contents).toBe(serviceContents("/usr/bin/headroom", "darwin", "/usr/bin/node", userInfo().username, "/Users/example"));
    expect(darwin.contents).toContain("<key>Label</key><string>com.headroom.daemon</string>");

    const windows = await installService("cli.js", "win32", "C:\\Users\\example", "node.exe", true, { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" }, "example");
    expect(windows.contents).toBe(serviceContents("cli.js", "win32", "node.exe", "example", "C:\\Users\\example", { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" }));
    expect(windows.contents).toContain("<Task version=\"1.4\"");

    // A real (non-dry-run) install still returns the exact contents it wrote to disk.
    const root = await mkdtemp(join(tmpdir(), "headroom-service-write-"));
    try {
      const written = await installService("/usr/bin/headroom", "linux", root, "/usr/bin/node", false);
      expect(written.contents).toBe(serviceContents("/usr/bin/headroom", "linux", "/usr/bin/node", userInfo().username, root));
      await expect(readFile(written.path, "utf8")).resolves.toBe(written.contents);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
