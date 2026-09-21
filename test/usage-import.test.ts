import { mkdir, mkdtemp, rm, writeFile, chmod, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, COMMAND_HELP } from "../src/cli.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = []; const stderr: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => { stdout.push(String(line)); });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => { stderr.push(String(line)); });
  return { stdout, stderr, restore: () => { logSpy.mockRestore(); errorSpy.mockRestore(); } };
}

/** Synthetic assistant transcript line: hand written to match the shape
 * usage-events.ts's parser accepts, never a capture of a real transcript. */
function assistantLine(overrides: { id?: string; model?: string; timestamp?: string; inputTokens?: number } = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: overrides.timestamp ?? "2026-09-20T10:00:00.000Z",
    message: {
      id: overrides.id ?? "msg_1",
      model: overrides.model ?? "claude-sonnet-5",
      usage: { input_tokens: overrides.inputTokens ?? 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

async function setupHome(prefix: string): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix)); temporary.push(root);
  const home = join(root, ".headroom");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return { root, home };
}

describe("headroom usage import", () => {
  it("imports a transcript file and reports accepted counters", async () => {
    const { root, home } = await setupHome("usage-import-");
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${assistantLine()}\n`);

    await withHeadroomHome(home, async () => {
      const { stdout, restore } = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript]);
        expect(code).toBe(0);
        expect(stdout.some((line) => line.startsWith("imported: cursor "))).toBe(true);
        expect(stdout.some((line) => line.includes("accepted_new=1"))).toBe(true);
      } finally { restore(); }
    });
  });

  it("never echoes the raw --path in human output", async () => {
    const { root, home } = await setupHome("usage-import-path-");
    const transcript = join(root, "CANARY_SECRET_TRANSCRIPT.jsonl");
    await writeFile(transcript, `${assistantLine()}\n`);

    await withHeadroomHome(home, async () => {
      const { stdout, restore } = captureOutput();
      try {
        await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript]);
        expect(stdout.join("\n")).not.toContain("CANARY_SECRET_TRANSCRIPT");
      } finally { restore(); }
    });
  });

  it("prints --json output with a version and generated_at, no raw path", async () => {
    const { root, home } = await setupHome("usage-import-json-");
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${assistantLine()}\n`);

    await withHeadroomHome(home, async () => {
      const { stdout, restore } = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript, "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(stdout[0]);
        expect(payload.kind).toBe("imported");
        expect(payload.version).toBe("1");
        expect(typeof payload.generated_at).toBe("string");
        expect(payload.counters.accepted_new).toBe(1);
        expect(JSON.stringify(payload)).not.toContain(transcript);
      } finally { restore(); }
    });
  });

  it("re-running the same import is idempotent (duplicate, not accepted_new)", async () => {
    const { root, home } = await setupHome("usage-import-dup-");
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${assistantLine()}\n`);

    await withHeadroomHome(home, async () => {
      await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript]);
      await writeFile(transcript, `${assistantLine()}\n${assistantLine({ id: "msg_2" })}\n`);
      const { stdout, restore } = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript, "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(stdout[0]);
        expect(payload.counters.accepted_new).toBe(1);
      } finally { restore(); }
    });
  });

  it("returns a safe, path-free error for a missing file", async () => {
    const { home } = await setupHome("usage-import-missing-");
    await withHeadroomHome(home, async () => {
      await expect(main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", "/tmp/CANARY_DOES_NOT_EXIST_9182.jsonl"]))
        .rejects.toThrow("the file at --path does not exist");
    });
  });

  it.skipIf(process.platform === "win32")("returns a safe, path-free error for an unsafe-permission file", async () => {
    const { root, home } = await setupHome("usage-import-unsafe-");
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${assistantLine()}\n`);
    await chmod(transcript, 0o666);
    await withHeadroomHome(home, async () => {
      await expect(main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript]))
        .rejects.toThrow("group- or world-writable");
    });
  });

  it("refuses a conflicting --principal for the same source/path with a nonzero exit", async () => {
    const { root, home } = await setupHome("usage-import-conflict-");
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${assistantLine()}\n`);
    await withHeadroomHome(home, async () => {
      await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript]);
      const { stdout, restore } = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-other", "--path", transcript]);
        expect(code).toBe(1);
        expect(stdout.some((line) => line.startsWith("refused:"))).toBe(true);
      } finally { restore(); }
    });
  });
});

describe("headroom usage import-status", () => {
  it("does not create any state when no usage.db exists", async () => {
    const { home } = await setupHome("usage-status-nostate-");
    await withHeadroomHome(home, async () => {
      const { stdout, restore } = captureOutput();
      try {
        const code = await main(["usage", "import-status"]);
        expect(code).toBe(0);
        expect(stdout.some((line) => line.includes("no usage data imported yet"))).toBe(true);
      } finally { restore(); }
      let exists = true;
      try { await lstat(join(home, "usage.db")); } catch { exists = false; }
      expect(exists).toBe(false);
    });
  });

  it("reports grouped totals and cursors after an import, human and json", async () => {
    const { root, home } = await setupHome("usage-status-");
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${assistantLine()}\n`);

    await withHeadroomHome(home, async () => {
      await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript]);

      const human = captureOutput();
      try {
        const code = await main(["usage", "import-status"]);
        expect(code).toBe(0);
        expect(human.stdout.some((line) => line.startsWith("cursors: 1"))).toBe(true);
        expect(human.stdout.some((line) => line.includes("model=claude-sonnet-5"))).toBe(true);
      } finally { human.restore(); }

      const json = captureOutput();
      try {
        const code = await main(["usage", "import-status", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(json.stdout[0]);
        expect(payload.version).toBe("1");
        expect(payload.cursors).toHaveLength(1);
        expect(payload.totals).toHaveLength(1);
        expect(payload.totals[0].model).toBe("claude-sonnet-5");
        expect(payload.totals[0].inputTokens).toEqual({ total: 100, overflow: false, known: 1, unknown: 0 });
      } finally { json.restore(); }
    });
  });
});

describe("headroom usage import: partial lines, hashes, coverage, rejection counters", () => {
  it("a trailing line without its newline is not finished and reports pendingPartial", async () => {
    const { root, home } = await setupHome("usage-import-partial-");
    const transcript = join(root, "transcript.jsonl");
    // Deliberately no trailing newline: the collector must leave this
    // uncommitted rather than guess it is complete.
    await writeFile(transcript, assistantLine());

    await withHeadroomHome(home, async () => {
      const { stdout, restore } = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript, "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(stdout[0]);
        expect(payload.finished).toBe(false);
        expect(payload.pendingPartial).toBe(true);
        expect(payload.counters.accepted_new ?? 0).toBe(0);
      } finally { restore(); }

      // Appending the missing newline completes the line; re-running the
      // same command now finishes it.
      await writeFile(transcript, `${assistantLine()}\n`);
      const done = captureOutput();
      try {
        const code = await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript, "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(done.stdout[0]);
        expect(payload.finished).toBe(true);
        expect(payload.pendingPartial).toBe(false);
        expect(payload.counters.accepted_new).toBe(1);
      } finally { done.restore(); }
    });
  });

  it("--json carries the full 32-hex cursorKey, not a truncated hash", async () => {
    const { root, home } = await setupHome("usage-import-hash-");
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${assistantLine()}\n`);

    await withHeadroomHome(home, async () => {
      const { stdout, restore } = captureOutput();
      try {
        await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript, "--json"]);
        const payload = JSON.parse(stdout[0]);
        expect(payload.cursorKey).toMatch(/^[0-9a-f]{32}$/);
      } finally { restore(); }
    });
  });

  it("import --json and the no-data import-status --json both carry coverage/evidence markers", async () => {
    const { root, home } = await setupHome("usage-import-coverage-");
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${assistantLine()}\n`);

    await withHeadroomHome(home, async () => {
      const importOut = captureOutput();
      try {
        await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript, "--json"]);
        const payload = JSON.parse(importOut.stdout[0]);
        expect(payload.coverage).toBe("imported_files_only");
        expect(payload.account_coverage).toBe("unknown");
        expect(payload.evidence).toBe("message_visible");
      } finally { importOut.restore(); }
    });
  });

  it("no-data import-status --json still carries coverage/evidence markers", async () => {
    const { home } = await setupHome("usage-status-coverage-");
    await withHeadroomHome(home, async () => {
      const { stdout, restore } = captureOutput();
      try {
        const code = await main(["usage", "import-status", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(stdout[0]);
        expect(payload.coverage).toBe("imported_files_only");
        expect(payload.account_coverage).toBe("unknown");
        expect(payload.evidence).toBe("message_visible");
        expect(payload.cursors).toEqual([]);
      } finally { restore(); }
    });
  });

  it("import-status surfaces rejection counters for an unrecognized model", async () => {
    const { root, home } = await setupHome("usage-status-rejected-");
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${assistantLine({ model: "gpt-4" })}\n`);

    await withHeadroomHome(home, async () => {
      await main(["usage", "import", "--source", "codex-cli", "--principal", "claude-main", "--path", transcript]);

      const { stdout, restore } = captureOutput();
      try {
        const code = await main(["usage", "import-status", "--json"]);
        expect(code).toBe(0);
        const payload = JSON.parse(stdout[0]);
        expect(payload.counters["rejected:unknown_model"]).toBe(1);
        expect(payload.totals).toEqual([]);
      } finally { restore(); }
    });
  });
});

describe("headroom usage help", () => {
  it("still documents --paste/--clipboard alongside import/import-status", () => {
    expect(COMMAND_HELP.usage).toContain("--paste");
    expect(COMMAND_HELP.usage).toContain("usage import");
    expect(COMMAND_HELP.usage).toContain("usage import-status");
  });

  it("prints usage help via --help without touching any store", async () => {
    const { home } = await setupHome("usage-help-");
    await withHeadroomHome(home, async () => {
      const { stdout, restore } = captureOutput();
      try {
        const code = await main(["usage", "import", "--help"]);
        expect(code).toBe(0);
        expect(stdout.join("\n")).toContain("usage import");
      } finally { restore(); }
    });
  });
});
