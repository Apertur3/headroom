import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { joinForPlatform, headroomHome } from "./paths.js";
import { daemonLogPath } from "./logs.js";

export function servicePath(platform = process.platform, home = homedir(), env = process.env): string {
  if (platform === "darwin") return joinForPlatform(platform, home, "Library", "LaunchAgents", "com.headroom.daemon.plist");
  if (platform === "win32") return joinForPlatform(platform, headroomHome({ platform, home, env }), "headroom-daemon.xml");
  return joinForPlatform(platform, home, ".config", "systemd", "user", "headroom.service");
}

export function serviceEnvironmentPath(home: string, platform = process.platform, inherited = process.env.PATH): string {
  const separator = platform === "win32" ? ";" : ":";
  const local = joinForPlatform(platform, home, ".local", "bin");
  const required = platform === "win32" ? [local] : [local, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set([...required, ...(inherited ?? "").split(separator).filter(Boolean)])].join(separator);
}

function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }

export function windowsTaskXml(script: string, runtime: string, username = userInfo().username, logPath?: string, pathValue = serviceEnvironmentPath(homedir(), "win32")): string {
  const command = logPath ? "cmd.exe" : runtime;
  const arguments_ = logPath ? `/d /s /c "set \"PATH=${pathValue}\" && \"${runtime}\" \"${script}\" daemon >> \"${logPath}\" 2>&1"` : `"${script}" daemon`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principals><Principal id="Author"><UserId>${xml(username)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Hidden>true</Hidden><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>${xml(command)}</Command><Arguments>${xml(arguments_)}</Arguments></Exec></Actions></Task>\n`;
}

export function serviceContents(script: string, platform = process.platform, runtime = process.execPath, username = userInfo().username, home = homedir(), env = process.env): string {
  const log = daemonLogPath(headroomHome({ platform, home, env }));
  const path = serviceEnvironmentPath(home, platform, env.PATH);
  if (platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.headroom.daemon</string><key>ProgramArguments</key><array><string>${xml(runtime)}</string><string>${xml(script)}</string><string>daemon</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
  if (platform === "win32") return windowsTaskXml(script, runtime, username, log, path);
  return `[Unit]\nDescription=Headroom quota daemon\n[Service]\nEnvironment="PATH=${path}"\nExecStart=${JSON.stringify(runtime)} ${JSON.stringify(script)} daemon\nStandardOutput=append:${log}\nStandardError=append:${log}\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`;
}

export async function installService(script = process.argv[1] ?? "headroom", platform = process.platform, home = homedir(), runtime = process.execPath, dryRun = false, env = process.env, username = userInfo().username): Promise<{ path: string; command: string; dryRun: boolean }> {
  const path = servicePath(platform, home, env);
  const command = platform === "darwin" ? `launchctl bootstrap gui/$(id -u) ${path}` : platform === "win32" ? `schtasks /Create /TN "Headroom Daemon" /XML "${path}" /F` : "systemctl --user enable --now headroom.service";
  const contents = serviceContents(script, platform, runtime, username, home, env);
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await mkdir(dirname(daemonLogPath(headroomHome({ platform, home, env }))), { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { mode: 0o600 });
  }
  return { path, command, dryRun };
}

export async function uninstallService(platform = process.platform, home = homedir(), dryRun = false, env = process.env): Promise<{ path: string; command: string; dryRun: boolean }> {
  const path = servicePath(platform, home, env);
  if (!dryRun) await rm(path, { force: true });
  return { path, dryRun, command: platform === "darwin" ? `launchctl bootout gui/$(id -u) ${path}` : platform === "win32" ? "schtasks /Delete /TN \"Headroom Daemon\" /F" : "systemctl --user disable --now headroom.service" };
}
