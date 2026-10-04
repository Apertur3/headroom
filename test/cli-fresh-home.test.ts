import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_ACCOUNTS_MESSAGE, runCli } from "../src/cli.js";
import { AccountsMissingError, readAccounts } from "../src/registry.js";

vi.mock("../src/engine/native/run.js", async (original) => ({
  ...await original<typeof import("../src/engine/native/run.js")>(),
  nativeEnginePath: vi.fn(async () => undefined),
}));

let home: string;
let previousHome: string | undefined;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "headroom-fresh-"));
  previousHome = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { err.push(args.join(" ")); });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
  const code = await runCli(argv);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const decisions: Array<[string, string[]]> = [
  ["can", ["can", "edit", "--owner", "agent"]],
  ["route", ["route", "--class", "edit", "--owner", "agent"]],
  ["gate", ["gate", "--need", "5h:5", "--class", "edit", "--owner", "agent"]],
];
const readers: Array<[string, string[]]> = [
  ["status", ["status"]],
  ["dashboard --once --ascii", ["dashboard", "--once", "--ascii"]],
];

describe.each([["no accounts.toml", false], ["an empty accounts.toml", true]])("a fresh home with %s", (_name, empty) => {
  beforeEach(async () => { if (empty) await writeFile(join(home, "accounts.toml"), ""); });

  it.each(decisions)("%s says nothing is configured and exits 2 (no capacity, never a yes)", async (_command, argv) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.err).toContain(NO_ACCOUNTS_MESSAGE);
    expect(`${result.out}${result.err}`).not.toMatch(/ENOENT|headroom error/);
  });

  it.each(readers)("%s says nothing is configured and exits 1", async (_command, argv) => {
    const result = await run(argv);
    // An empty (not missing) registry keeps status's historic exit 0, with the message on stderr.
    expect(result.code).toBe(empty && argv[0] === "status" ? 0 : 1);
    expect(result.err).toContain(NO_ACCOUNTS_MESSAGE);
    expect(`${result.out}${result.err}`).not.toMatch(/ENOENT|headroom error/);
  });

  it("--json keeps stdout parseable with the same message", async () => {
    const result = await run(["can", "edit", "--owner", "agent", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toEqual({ error: NO_ACCOUNTS_MESSAGE });
  });

  it("doctor guides to accounts discover and exits 0", async () => {
    const result = await run(["doctor"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/WARN principals:.*headroom accounts discover/);
    expect(result.out).not.toMatch(/FAIL principals|ENOENT/);
  });
});

describe("AccountsMissingError", () => {
  it("is what readAccounts throws on a fresh home, with the ENOENT code kept", async () => {
    const error = await readAccounts().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountsMissingError);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});
