import { homedir } from "node:os";
import { join, win32 } from "node:path";

export interface PathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function values(options: PathOptions): Required<PathOptions> {
  return { platform: options.platform ?? process.platform, env: options.env ?? process.env, home: options.home ?? homedir() };
}

export function joinForPlatform(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? win32.join(...parts) : join(...parts);
}

export function tallyHome(options: PathOptions = {}): string {
  const { platform, env, home } = values(options);
  if (env.TALLY_HOME) return env.TALLY_HOME;
  if (platform === "win32") return joinForPlatform(platform, env.LOCALAPPDATA || joinForPlatform(platform, home, "AppData", "Local"), "keeptally");
  return joinForPlatform(platform, home, ".tally");
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export type VendorHome = "claude" | "codex" | "gemini";

export function vendorHome(vendor: VendorHome, options: PathOptions = {}): string {
  const { home } = values(options);
  return joinForPlatform(values(options).platform, home, `.${vendor}`);
}

/** Credential locations used by native TypeScript adapters. Claude uses the
 * macOS Keychain instead of this file when running on macOS. */
export function credentialPath(vendor: "claude" | "codex" | "antigravity", location?: string, options: PathOptions = {}): string {
  const directory = location || vendorHome(vendor === "antigravity" ? "gemini" : vendor, options);
  const filename = vendor === "claude" ? ".credentials.json" : vendor === "codex" ? "auth.json" : "oauth_creds.json";
  return joinForPlatform(values(options).platform, directory, filename);
}
