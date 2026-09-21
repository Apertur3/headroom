export const DEFAULT_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export const MIN_IMPORT_BYTES = 256 * 1024 + 1;

export type UsageImportOptions =
  | { command: "import"; source: string; principal: string; path: string; job?: string; maxBytes: number; json: boolean }
  | { command: "import-status"; json: boolean };

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function parseUsageImportOptions(argv: readonly string[]): UsageImportOptions {
  if (argv.length === 0) throw new Error("Invalid command");
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === "import-status") {
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--json") {
        if (json) throw new Error("Duplicate flag: --json");
        json = true;
      } else {
        throw new Error("Unknown flag");
      }
    }
    return { command: "import-status", json };
  }

  if (cmd !== "import") throw new Error("Invalid command");

  let source: string | undefined;
  let principal: string | undefined;
  let path: string | undefined;
  let job: string | undefined;
  let maxBytesStr: string | undefined;
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const flag = arg;
      if (flag === "--source" || flag === "--principal" || flag === "--path" || flag === "--job" || flag === "--max-bytes") {
        if (i + 1 >= rest.length) throw new Error(`Missing value for ${flag}`);
        const val = rest[i + 1];
        if (val.startsWith("--")) throw new Error(`Invalid value for ${flag}`);
        i++;
        if (flag === "--source") {
          if (source !== undefined) throw new Error("Duplicate flag: --source");
          if (!ALIAS_RE.test(val)) throw new Error("Invalid value for --source");
          source = val;
        } else if (flag === "--principal") {
          if (principal !== undefined) throw new Error("Duplicate flag: --principal");
          if (!ALIAS_RE.test(val)) throw new Error("Invalid value for --principal");
          principal = val;
        } else if (flag === "--path") {
          if (path !== undefined) throw new Error("Duplicate flag: --path");
          if (val.length === 0 || val.includes("\u0000") || val.length > 4096) throw new Error("Invalid value for --path");
          path = val;
        } else if (flag === "--job") {
          if (job !== undefined) throw new Error("Duplicate flag: --job");
          if (!ALIAS_RE.test(val)) throw new Error("Invalid value for --job");
          job = val;
        } else if (flag === "--max-bytes") {
          if (maxBytesStr !== undefined) throw new Error("Duplicate flag: --max-bytes");
          if (!/^[0-9]+$/.test(val)) throw new Error("Invalid value for --max-bytes");
          maxBytesStr = val;
        }
      } else if (flag === "--json") {
        if (json) throw new Error("Duplicate flag: --json");
        json = true;
      } else {
        throw new Error("Unknown flag");
      }
    } else {
      throw new Error("Unexpected positional argument");
    }
  }

  if (source === undefined) throw new Error("Missing required flag: --source");
  if (principal === undefined) throw new Error("Missing required flag: --principal");
  if (path === undefined) throw new Error("Missing required flag: --path");

  let maxBytes = DEFAULT_IMPORT_BYTES;
  if (maxBytesStr !== undefined) {
    const n = Number(maxBytesStr);
    if (!Number.isSafeInteger(n) || n < MIN_IMPORT_BYTES || n > MAX_IMPORT_BYTES) {
      throw new Error("Invalid value for --max-bytes");
    }
    maxBytes = n;
  }

  const result: UsageImportOptions = { command: "import", source, principal, path, maxBytes, json };
  if (job !== undefined) result.job = job;
  return result;
}
