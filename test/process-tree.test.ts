import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { descendantsOf, killTree, listProcesses, processSignature, type ProcessEntry } from "../src/process-tree.js";
import { agyPtyCommand } from "../src/antigravity-keepalive.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      const text = await readFile(path, "utf8");
      if (text.trim()) return text.trim();
    } catch { /* not written yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A delivered SIGKILL is not instantaneous: the kernel still has to
 * schedule the target and its parent gets to reap it, typically within a
 * handful of milliseconds but not synchronously with the syscall that sent
 * it. Every assertion below waits this out instead of checking `alive()`
 * the instant a kill call returns. */
async function waitUntilDead(pid: number, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (alive(pid)) {
    if (Date.now() - start > timeoutMs) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("listProcesses", () => {
  it("parses pid/ppid/rss/comm, keeping a command that itself contains spaces intact as the trailing field", async () => {
    const fakePs = async () => ({
      stdout: [
        "    1     0  36064 /sbin/launchd",
        "  104     1  81984 /usr/libexec/logd",
        "  200   104   4096 /tmp/fake agy",
        "",
      ].join("\n"),
      stderr: "",
    });
    const result = await listProcesses(fakePs as never);
    expect(result).toEqual<ProcessEntry[]>([
      { pid: 1, ppid: 0, rssKb: 36064, command: "/sbin/launchd" },
      { pid: 104, ppid: 1, rssKb: 81984, command: "/usr/libexec/logd" },
      { pid: 200, ppid: 104, rssKb: 4096, command: "/tmp/fake agy" },
    ]);
  });

  it("returns an empty list, never throws, when ps itself fails", async () => {
    const failing = async () => { throw new Error("ps: not found"); };
    await expect(listProcesses(failing as never)).resolves.toEqual([]);
  });
});

describe("descendantsOf", () => {
  it("walks the ppid graph transitively and never includes the root itself", () => {
    const processes: ProcessEntry[] = [
      { pid: 10, ppid: 1, rssKb: 0, command: "script" },
      { pid: 11, ppid: 10, rssKb: 0, command: "agy" }, // direct child of script
      { pid: 12, ppid: 11, rssKb: 0, command: "agy-helper" }, // grandchild
      { pid: 99, ppid: 1, rssKb: 0, command: "unrelated" },
    ];
    const found = descendantsOf(10, processes).map((entry) => entry.pid).sort();
    expect(found).toEqual([11, 12]);
  });

  it("does not loop forever on a malformed ppid cycle", () => {
    const processes: ProcessEntry[] = [
      { pid: 1, ppid: 2, rssKb: 0, command: "a" },
      { pid: 2, ppid: 1, rssKb: 0, command: "b" },
    ];
    expect(descendantsOf(1, processes).map((entry) => entry.pid).sort()).toEqual([2]);
  });
});

describe.skipIf(process.platform === "win32")("killTree (real processes)", () => {
  it("kills a real descendant that traps SIGTERM/SIGHUP and becomes its own session/process-group leader -- the exact shape issue #56 leaked -- not just the root pid it was told to kill", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-killtree-")); temporary.push(root);
    const infoFile = join(root, "child-pid.txt");
    const fakeAgy = join(root, "agy");
    await writeFile(fakeAgy, [
      "#!/bin/sh",
      "trap '' TERM HUP",
      `echo $$ > ${infoFile}`,
      "while true; do sleep 1; done",
    ].join("\n"), { mode: 0o700 });
    await chmod(fakeAgy, 0o700);
    // The real vehicle for "a descendant escapes the root's process group",
    // not a stand-in for it: `script` allocates a PTY and its child (the
    // fake agy above) becomes that PTY's session leader with its OWN new
    // process group, distinct from script's -- verified by hand against a
    // real `script`/agy pair before this fix (see the PR description), and
    // exercised for real here rather than assumed.
    const [command, args] = agyPtyCommand(fakeAgy, process.platform);
    const rootChild = spawn(command, args, { stdio: "ignore", detached: true });
    const rootPid = rootChild.pid as number;
    const childPid = Number(await waitForFile(infoFile));
    expect(alive(childPid)).toBe(true);
    expect(childPid).not.toBe(rootPid); // the PTY child, not `script` itself

    await killTree(rootPid, { graceMs: 150 });

    await waitUntilDead(rootPid);
    await waitUntilDead(childPid);
  }, 10_000);

  it("a naive kill of only the root pid (the pre-fix behavior) leaves the PTY child alive -- this is issue #56 reproduced", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-killtree-naive-")); temporary.push(root);
    const infoFile = join(root, "child-pid.txt");
    const fakeAgy = join(root, "agy");
    await writeFile(fakeAgy, [
      "#!/bin/sh", "trap '' TERM HUP", `echo $$ > ${infoFile}`, "while true; do sleep 1; done",
    ].join("\n"), { mode: 0o700 });
    await chmod(fakeAgy, 0o700);
    const [command, args] = agyPtyCommand(fakeAgy, process.platform);
    const rootChild = spawn(command, args, { stdio: "ignore", detached: true });
    const rootPid = rootChild.pid as number;
    const childPid = Number(await waitForFile(infoFile));

    process.kill(rootPid, "SIGTERM"); // exactly what the old `child.kill("SIGTERM")` did
    await waitUntilDead(rootPid); // script itself is gone
    // Give the surviving orphan a fair window it clearly does not need: it
    // ignores SIGTERM entirely (trap), so it cannot legitimately die here.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(childPid)).toBe(true); // the orphan survives -- this is the bug

    await killTree(childPid, { graceMs: 150 }); // clean up this test's own orphan
    await waitUntilDead(childPid);
  }, 10_000);

  it("escalates to SIGKILL only after the grace period, for a target that ignores SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-killtree-grace-")); temporary.push(root);
    const script = join(root, "stubborn");
    await writeFile(script, "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 1; done\n", { mode: 0o700 });
    await chmod(script, 0o700);
    const child = spawn(script, [], { stdio: "ignore", detached: true });
    const pid = child.pid as number;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid)).toBe(true);

    await killTree(pid, { graceMs: 200 });
    await waitUntilDead(pid);
  }, 10_000);
});

describe.skipIf(process.platform === "win32")("processSignature", () => {
  it("reads a real process's command and start time, and the same pid queried twice agrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-signature-"));
    temporary.push(root);
    const script = join(root, "sleeper");
    await writeFile(script, "#!/bin/sh\nwhile true; do sleep 1; done\n", { mode: 0o700 });
    await chmod(script, 0o700);
    const child = spawn(script, [], { stdio: "ignore", detached: true });
    const pid = child.pid as number;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const first = await processSignature(pid);
      const second = await processSignature(pid);
      expect(first).toBeDefined();
      // Two independent `ps` reads of the same still-running process agree
      // exactly -- this is what sweepPreviousKeepalive() (in
      // antigravity-keepalive.ts) relies on to prove a pid it finds later is
      // still the same process it recorded, not one the OS has recycled.
      expect(first).toEqual(second);
      // A `#!/bin/sh` script's `comm` is the interpreter that is actually
      // running (/bin/sh), not the script's own filename -- real OS
      // behavior, not a parsing gap in processSignature().
      expect(first?.command).toContain("sh");
    } finally { await killTree(pid, { graceMs: 100 }); await waitUntilDead(pid); }
  }, 10_000);

  it("returns undefined for a pid that is not running", async () => {
    // A pid vanishingly unlikely to be live on any real machine or CI
    // runner, and never one this test itself started.
    await expect(processSignature(999_999)).resolves.toBeUndefined();
  });
});
