import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { joinForPlatform, tallyHome } from "./paths.js";

export function servicePath(platform = process.platform, home = homedir(), env = process.env): string {
  if (platform === "darwin") return joinForPlatform(platform, home, "Library", "LaunchAgents", "com.keeptally.daemon.plist");
  if (platform === "win32") return joinForPlatform(platform, tallyHome({ platform, home, env }), "keeptally-daemon.xml");
  return joinForPlatform(platform, home, ".config", "systemd", "user", "keeptally-daemon.service");
}

function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }

export function windowsTaskXml(script: string, runtime: string, username = userInfo().username): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principals><Principal id="Author"><UserId>${xml(username)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Hidden>true</Hidden><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>${xml(runtime)}</Command><Arguments>${xml(`"${script}" daemon`)}</Arguments></Exec></Actions></Task>\n`;
}

export function serviceContents(script: string, platform = process.platform, runtime = process.execPath, username = userInfo().username): string {
  if (platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.keeptally.daemon</string><key>ProgramArguments</key><array><string>${runtime}</string><string>${script}</string><string>daemon</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
  if (platform === "win32") return windowsTaskXml(script, runtime, username);
  return `[Unit]\nDescription=Tally quota daemon\n[Service]\nExecStart=${JSON.stringify(runtime)} ${JSON.stringify(script)} daemon\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`;
}

export async function installService(script = process.argv[1] ?? "tally", platform = process.platform, home = homedir(), runtime = process.execPath, dryRun = false, env = process.env, username = userInfo().username): Promise<{ path: string; command: string; dryRun: boolean }> {
  const path = servicePath(platform, home, env);
  const command = platform === "darwin" ? `launchctl bootstrap gui/$(id -u) ${path}` : platform === "win32" ? `schtasks /Create /TN "Keeptally Daemon" /XML "${path}" /F` : "systemctl --user enable --now keeptally-daemon.service";
  const contents = serviceContents(script, platform, runtime, username);
  if (!dryRun) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, contents, { mode: 0o600 }); }
  return { path, command, dryRun };
}

export async function uninstallService(platform = process.platform, home = homedir(), dryRun = false, env = process.env): Promise<{ path: string; command: string; dryRun: boolean }> {
  const path = servicePath(platform, home, env);
  if (!dryRun) await rm(path, { force: true });
  return { path, dryRun, command: platform === "darwin" ? `launchctl bootout gui/$(id -u) ${path}` : platform === "win32" ? "schtasks /Delete /TN \"Keeptally Daemon\" /F" : "systemctl --user disable --now keeptally-daemon.service" };
}
