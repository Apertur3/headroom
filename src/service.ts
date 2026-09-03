import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function servicePath(platform = process.platform, home = homedir()): string {
  return platform === "darwin" ? join(home, "Library", "LaunchAgents", "com.keeptally.daemon.plist") : join(home, ".config", "systemd", "user", "keeptally-daemon.service");
}

export async function installService(script = process.argv[1] ?? "tally", platform = process.platform, home = homedir(), runtime = process.execPath, dryRun = false): Promise<{ path: string; command: string; dryRun: boolean }> {
  const path = servicePath(platform, home);
  const command = platform === "darwin" ? `launchctl bootstrap gui/$(id -u) ${path}` : `systemctl --user enable --now keeptally-daemon.service`;
  const contents = platform === "darwin"
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.keeptally.daemon</string><key>ProgramArguments</key><array><string>${runtime}</string><string>${script}</string><string>daemon</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`
    : `[Unit]\nDescription=Tally quota daemon\n[Service]\nExecStart=${JSON.stringify(runtime)} ${JSON.stringify(script)} daemon\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`;
  if (!dryRun) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, contents, { mode: 0o600 }); }
  return { path, command, dryRun };
}

export async function uninstallService(platform = process.platform, home = homedir()): Promise<{ path: string; command: string }> {
  const path = servicePath(platform, home);
  await rm(path, { force: true });
  return { path, command: platform === "darwin" ? `launchctl bootout gui/$(id -u) ${path}` : "systemctl --user disable --now keeptally-daemon.service" };
}
