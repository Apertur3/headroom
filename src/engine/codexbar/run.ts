import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderAccount } from "../../types.js";
import { readPolicy } from "../../config.js";
import { outboundEnvironment, redact } from "../../security.js";

const execFileAsync = promisify(execFile);

export interface EngineResult { payload: unknown; stderr: string }

/** Runs only an engine path returned by verifiedEnginePath(), never an ambient executable. */
export async function runCodexBar(enginePath: string, account: ProviderAccount): Promise<EngineResult> {
  const { proxy } = await readPolicy();
  const env = outboundEnvironment(proxy, { PATH: process.env.PATH ?? "" });
  if (account.vendor === "codex") env.CODEX_HOME = account.location;
  else env.CLAUDE_CONFIG_DIR = account.location;
  try {
    const { stdout, stderr } = await execFileAsync(enginePath, ["usage", "--provider", account.vendor, "--format", "json"], {
      env,
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    try { return { payload: JSON.parse(stdout), stderr: redact(stderr) }; }
    catch { throw new Error(`Engine returned invalid JSON: ${redact(stderr) || "no diagnostic"}`); }
  } catch (error: unknown) {
    const detail = error as { stderr?: string; killed?: boolean; signal?: string; message?: string };
    const suffix = detail.killed || detail.signal === "SIGTERM" ? "engine timed out after 90s" : detail.stderr || detail.message || "engine failed";
    throw new Error(redact(suffix));
  }
}
