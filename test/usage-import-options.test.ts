import { describe, it, expect } from "vitest";
import { parseUsageImportOptions, DEFAULT_IMPORT_BYTES, MAX_IMPORT_BYTES, MIN_IMPORT_BYTES } from "../src/usage-import-options.js";

describe("parseUsageImportOptions", () => {
  it("parses valid import with defaults", () => {
    const res = parseUsageImportOptions(["import", "--source", "src", "--principal", "prin", "--path", "p"]);
    expect(res).toEqual({ command: "import", source: "src", principal: "prin", path: "p", maxBytes: DEFAULT_IMPORT_BYTES, json: false });
  });

  it("parses import with all options", () => {
    const res = parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "x", "--job", "j", "--max-bytes", "1000000", "--json"]);
    expect(res).toEqual({ command: "import", source: "s", principal: "p", path: "x", job: "j", maxBytes: 1000000, json: true });
  });

  it("parses import-status with json", () => {
    const res = parseUsageImportOptions(["import-status", "--json"]);
    expect(res).toEqual({ command: "import-status", json: true });
  });

  it("parses import-status without json", () => {
    const res = parseUsageImportOptions(["import-status"]);
    expect(res).toEqual({ command: "import-status", json: false });
  });

  it("rejects unknown command", () => {
    expect(() => parseUsageImportOptions(["invalid"])).toThrow("Invalid command");
  });

  it("rejects unknown flag in import", () => {
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "p", "--unknown"])).toThrow("Unknown flag");
  });

  it("rejects unknown flag in status", () => {
    expect(() => parseUsageImportOptions(["import-status", "--source"])).toThrow("Unknown flag");
  });

  it("rejects duplicate flags", () => {
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--source", "s2", "--principal", "p", "--path", "p"])).toThrow("Duplicate flag: --source");
    expect(() => parseUsageImportOptions(["import-status", "--json", "--json"])).toThrow("Duplicate flag: --json");
  });

  it("rejects missing required flags", () => {
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--principal", "p"])).toThrow("Missing required flag: --path");
  });

  it("rejects missing value", () => {
    expect(() => parseUsageImportOptions(["import", "--source"])).toThrow("Missing value for --source");
  });

  it("rejects value starting with --", () => {
    expect(() => parseUsageImportOptions(["import", "--source", "--bad", "--principal", "p", "--path", "p"])).toThrow("Invalid value for --source");
  });

  it("rejects invalid alias format", () => {
    expect(() => parseUsageImportOptions(["import", "--source", "-bad", "--principal", "p", "--path", "p"])).toThrow("Invalid value for --source");
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "p", "--job", "-bad"])).toThrow("Invalid value for --job");
  });

  it("rejects invalid path", () => {
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", ""])).toThrow("Invalid value for --path");
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "a\u0000b"])).toThrow("Invalid value for --path");
  });

  it("rejects invalid max-bytes syntax", () => {
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "p", "--max-bytes", "-1"])).toThrow("Invalid value for --max-bytes");
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "p", "--max-bytes", "1.5"])).toThrow("Invalid value for --max-bytes");
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "p", "--max-bytes", "1e3"])).toThrow("Invalid value for --max-bytes");
  });

  it("rejects out of bounds max-bytes", () => {
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "p", "--max-bytes", String(MIN_IMPORT_BYTES - 1)])).toThrow("Invalid value for --max-bytes");
    expect(() => parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "p", "--max-bytes", String(MAX_IMPORT_BYTES + 1)])).toThrow("Invalid value for --max-bytes");
  });

  it("accepts boundary max-bytes", () => {
    const res1 = parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "p", "--max-bytes", String(MIN_IMPORT_BYTES)]);
    if (res1.command !== "import") throw new Error("Expected import command");
    expect(res1.maxBytes).toBe(MIN_IMPORT_BYTES);
    const res2 = parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "p", "--max-bytes", String(MAX_IMPORT_BYTES)]);
    if (res2.command !== "import") throw new Error("Expected import command");
    expect(res2.maxBytes).toBe(MAX_IMPORT_BYTES);
  });

  // Tests are synthetic
  it("does not leak secret values in errors", () => {
    const secret = "SECRET_CANARY_123";
    const cases: { args: string[]; description: string }[] = [
      { args: [secret], description: "invalid command" },
      { args: ["import", "--source", "s", "--principal", "p", "--path", "p", "--" + secret], description: "unknown flag containing canary" },
      { args: ["import", "--source", "s", "--principal", "p", "--path", "p", "--max-bytes", secret], description: "invalid numeric value canary" }
    ];

    for (const { args, description } of cases) {
      let error: Error | undefined;
      try {
        parseUsageImportOptions(args);
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).not.toContain(secret);
    }
  });

  it("handles argv order shuffled and original array unchanged", () => {
    const shuffled = ["import", "--path", "p", "--principal", "p", "--source", "s"];
    const original = [...shuffled];
    const res = parseUsageImportOptions(shuffled);
    expect(res).toEqual({ command: "import", source: "s", principal: "p", path: "p", maxBytes: DEFAULT_IMPORT_BYTES, json: false });
    expect(shuffled).toEqual(original);
  });

  it("handles valid path with spaces", () => {
    const res = parseUsageImportOptions(["import", "--source", "s", "--principal", "p", "--path", "my path with spaces"]);
    expect(res).toEqual({ command: "import", source: "s", principal: "p", path: "my path with spaces", maxBytes: DEFAULT_IMPORT_BYTES, json: false });
  });
});
