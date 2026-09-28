import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkHostHealth, classifyHostHealth, defaultHostGuardPolicy, hostGuardRefusal, hostGuardWarning,
  parseHostGuardPolicy, readHostGuardPolicy, type HostHealth, type HostMeasurements,
} from "../src/host-health.js";
import type { ProcessEntry } from "../src/process-tree.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const allUnknown: HostMeasurements = { load_ratio: null, pty_used: null, pty_max: null, orphans: null };

describe("classifyHostHealth", () => {
  it("is ok when every measurement sits under its warn threshold", () => {
    const result = classifyHostHealth({ load_ratio: 1, pty_used: 10, pty_max: 100, orphans: 0 });
    expect(result).toEqual({ state: "ok", reasons: [] });
  });

  it("warns above warn_load_ratio but at or under refuse_load_ratio", () => {
    const result = classifyHostHealth({ ...allUnknown, load_ratio: 2.5 });
    expect(result.state).toBe("warn");
    expect(result.reasons[0]).toContain("load_ratio 2.50");
    expect(result.reasons[0]).toContain("host_guard.warn_load_ratio");
    // Exactly at the refuse threshold is not yet over it.
    expect(classifyHostHealth({ ...allUnknown, load_ratio: defaultHostGuardPolicy.refuse_load_ratio }).state).toBe("warn");
  });

  it("refuses above refuse_load_ratio", () => {
    const result = classifyHostHealth({ ...allUnknown, load_ratio: 3.01 });
    expect(result.state).toBe("refuse");
    expect(result.reasons[0]).toContain("load_ratio 3.01");
    expect(result.reasons[0]).toContain("host_guard.refuse_load_ratio");
  });

  it("warns above warn_pty_percent but at or under refuse_pty_percent", () => {
    const result = classifyHostHealth({ ...allUnknown, pty_used: 51, pty_max: 100 });
    expect(result.state).toBe("warn");
    expect(result.reasons[0]).toContain("pty use 51%");
    expect(result.reasons[0]).toContain("host_guard.warn_pty_percent");
  });

  it("refuses above refuse_pty_percent", () => {
    const result = classifyHostHealth({ ...allUnknown, pty_used: 76, pty_max: 100 });
    expect(result.state).toBe("refuse");
    expect(result.reasons[0]).toContain("pty use 76%");
    expect(result.reasons[0]).toContain("host_guard.refuse_pty_percent");
  });

  it("ignores a pty_max of 0 (division would be meaningless) rather than treating it as 100% use", () => {
    // pty_used/pty_max are both real (non-null) readings here, just not a
    // usable percentage -- this is "ok" (nothing crossed a threshold),
    // distinct from "unknown" (nothing could be read at all).
    const result = classifyHostHealth({ ...allUnknown, pty_used: 0, pty_max: 0 });
    expect(result.state).toBe("ok");
  });

  it("orphans alone always warn, never refuse, at any count above zero", () => {
    const one = classifyHostHealth({ ...allUnknown, orphans: 1 });
    expect(one.state).toBe("warn");
    expect(one.reasons[0]).toContain("orphaned agy");
    const many = classifyHostHealth({ ...allUnknown, orphans: 500 });
    expect(many.state).toBe("warn"); // not "refuse", however large
  });

  it("a refuse-worthy measurement wins over a merely warn-worthy one", () => {
    const result = classifyHostHealth({ load_ratio: 10, pty_used: 51, pty_max: 100, orphans: 3 });
    expect(result.state).toBe("refuse");
    expect(result.reasons.length).toBeGreaterThan(1); // every crossed threshold is named, not just the deciding one
  });

  it("is unknown only when every measurement is null, never merely absent-ish", () => {
    expect(classifyHostHealth(allUnknown).state).toBe("unknown");
    expect(classifyHostHealth({ load_ratio: 0, pty_used: null, pty_max: null, orphans: null }).state).toBe("ok");
  });

  it("null measurements never contribute to warn or refuse even under aggressive custom thresholds", () => {
    const aggressive = { ...defaultHostGuardPolicy, warn_load_ratio: 0.001, refuse_load_ratio: 0.002, warn_pty_percent: 0.001, refuse_pty_percent: 0.002 };
    expect(classifyHostHealth(allUnknown, aggressive).state).toBe("unknown");
  });
});

describe("checkHostHealth (injected probes -- no real load, no real PTYs)", () => {
  it("never throws when every probe fails, and reports every measurement unknown", async () => {
    const health = await checkHostHealth(defaultHostGuardPolicy, {
      platform: "linux",
      loadavg: () => { throw new Error("boom"); },
      cpuCount: () => { throw new Error("boom"); },
      readFileImpl: (async () => { throw new Error("boom"); }) as never,
      listProcessesImpl: async () => { throw new Error("boom"); },
    });
    expect(health).toEqual<HostHealth>({ state: "unknown", reasons: ["no host pressure measurements available on this platform"], load_ratio: null, pty_used: null, pty_max: null, orphans: null });
  });

  it("treats win32's always-zero os.loadavg() as unknown, not as a real idle reading", async () => {
    const health = await checkHostHealth(defaultHostGuardPolicy, {
      platform: "win32",
      loadavg: () => [0, 0, 0],
      cpuCount: () => 8,
      listProcessesImpl: async () => [],
    });
    expect(health.load_ratio).toBeNull();
    expect(health.pty_used).toBeNull();
    expect(health.pty_max).toBeNull();
    expect(health.orphans).toBeNull(); // no script/agy PTY tree to walk on win32
    expect(health.state).toBe("unknown");
  });

  it("computes a real ratio on a non-windows platform from injected loadavg/cpu probes", async () => {
    const health = await checkHostHealth(defaultHostGuardPolicy, {
      platform: "linux",
      loadavg: () => [8, 5, 4],
      cpuCount: () => 2,
      readFileImpl: (async (path: string) => { if (path.endsWith("/max")) return "4096\n"; if (path.endsWith("/nr")) return "10\n"; throw new Error("unexpected path"); }) as never,
      listProcessesImpl: async () => [],
    });
    expect(health.load_ratio).toBe(4); // 8 / 2, strictly over the default refuse_load_ratio (3)
    expect(health.state).toBe("refuse");
  });

  it("darwin: reads sysctl for pty_max and counts /dev/ttys* for pty_used, both via injected probes", async () => {
    const execImpl = (async (file: string, args: readonly string[]) => {
      if (file === "sysctl" && args.includes("kern.tty.ptmx_max")) return { stdout: "128\n", stderr: "" };
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    }) as never;
    const readdirImpl = (async (path: string) => {
      if (path === "/dev") return ["ttys000", "ttys001", "ttys002", "console", "null"];
      throw new Error(`unexpected readdir: ${path}`);
    }) as never;
    const health = await checkHostHealth(defaultHostGuardPolicy, {
      platform: "darwin", loadavg: () => [0, 0, 0], cpuCount: () => 4, execImpl, readdirImpl, listProcessesImpl: async () => [],
    });
    expect(health.pty_max).toBe(128);
    expect(health.pty_used).toBe(3); // only the ttysNNN entries
  });

  it("a failing sysctl/readdir on darwin reports pty_used/pty_max unknown rather than throwing", async () => {
    const health = await checkHostHealth(defaultHostGuardPolicy, {
      platform: "darwin",
      loadavg: () => [0, 0, 0], cpuCount: () => 4,
      execImpl: (async () => { throw new Error("sysctl: denied"); }) as never,
      readdirImpl: (async () => { throw new Error("readdir: denied"); }) as never,
      listProcessesImpl: async () => [],
    });
    expect(health.pty_max).toBeNull();
    expect(health.pty_used).toBeNull();
  });

  it("counts orphaned agy processes via the shared process-tree predicate, ignoring live ones, a user's own orphaned `script` session, and unrelated commands", async () => {
    const processes: ProcessEntry[] = [
      { pid: 100, ppid: 1, rssKb: 1000, command: "/Users/test/.local/bin/agy" }, // orphaned
      { pid: 101, ppid: 1, rssKb: 500, command: "/usr/bin/script" }, // a user's own script session: not the leak shape
      { pid: 102, ppid: 555, rssKb: 500, command: "/usr/bin/script" }, // still has a live parent
      { pid: 103, ppid: 1, rssKb: 500, command: "/usr/bin/something-else" }, // orphaned, but not the leak shape
    ];
    const health = await checkHostHealth(defaultHostGuardPolicy, {
      platform: "linux", loadavg: () => [0, 0, 0], cpuCount: () => 4,
      readFileImpl: (async () => { throw new Error("no /proc here"); }) as never,
      listProcessesImpl: async () => processes,
    });
    expect(health.orphans).toBe(1);
    expect(health.state).toBe("warn");
  });

  it("reports orphans as unknown (never 0) when ps itself fails, since listProcesses reports a failure as an empty list", async () => {
    const health = await checkHostHealth(defaultHostGuardPolicy, {
      platform: "linux", loadavg: () => [0, 0, 0], cpuCount: () => 4,
      readFileImpl: (async () => { throw new Error("no /proc here"); }) as never,
      listProcessesImpl: async () => [], // listProcesses() itself never throws; a failed `ps` surfaces as []
    });
    expect(health.orphans).toBeNull(); // unknown, never a reassuring 0
    expect(health.reasons.join(" ")).not.toContain("orphaned");
  });
});

describe("parseHostGuardPolicy", () => {
  it("defaults every key when [host_guard] is absent", () => {
    expect(parseHostGuardPolicy("freeze_reserve_pct = 10\n")).toEqual(defaultHostGuardPolicy);
  });

  it("parses every documented key", () => {
    const text = [
      "[host_guard]", 'mode = "warn"', "warn_load_ratio = 1.5", "refuse_load_ratio = 2.5",
      "warn_pty_percent = 40", "refuse_pty_percent = 60",
    ].join("\n");
    expect(parseHostGuardPolicy(text)).toEqual({ mode: "warn", warn_load_ratio: 1.5, refuse_load_ratio: 2.5, warn_pty_percent: 40, refuse_pty_percent: 60 });
  });

  it("accepts every mode value", () => {
    expect(parseHostGuardPolicy('[host_guard]\nmode = "off"\n').mode).toBe("off");
    expect(parseHostGuardPolicy('[host_guard]\nmode = "refuse"\n').mode).toBe("refuse");
  });

  it("does not leak into a later, unrelated section", () => {
    const text = '[host_guard]\nmode = "warn"\n[reserve]\n"*" = 5\n';
    expect(parseHostGuardPolicy(text).mode).toBe("warn");
  });

  it("rejects an unknown [host_guard] key", () => {
    expect(() => parseHostGuardPolicy('[host_guard]\nbogus = 1\n')).toThrow(/unknown \[host_guard\] key/);
  });

  it("rejects an unknown mode value", () => {
    expect(() => parseHostGuardPolicy('[host_guard]\nmode = "yolo"\n')).toThrow();
  });

  it("rejects a refuse threshold at or below its warn threshold", () => {
    expect(() => parseHostGuardPolicy('[host_guard]\nwarn_load_ratio = 3\nrefuse_load_ratio = 3\n')).toThrow(/refuse_load_ratio/);
    expect(() => parseHostGuardPolicy('[host_guard]\nwarn_pty_percent = 80\nrefuse_pty_percent = 80\n')).toThrow(/refuse_pty_percent/);
  });

  it("rejects a pty percent above 100", () => {
    expect(() => parseHostGuardPolicy('[host_guard]\nrefuse_pty_percent = 150\n')).toThrow();
  });
});

async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

describe("readHostGuardPolicy", () => {
  it("returns the defaults when policy.toml does not exist at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-hostguard-")); temporary.push(root);
    await expect(readHostGuardPolicy(root)).resolves.toEqual(defaultHostGuardPolicy);
  });

  it("reads [host_guard] out of a real policy.toml on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-hostguard-")); temporary.push(root);
    await writeFile(join(root, "policy.toml"), '[host_guard]\nmode = "off"\n', { mode: 0o600 });
    await expect(readHostGuardPolicy(root)).resolves.toEqual({ ...defaultHostGuardPolicy, mode: "off" });
  });

  it("honors HEADROOM_HOME the same way every other policy read does", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-hostguard-")); temporary.push(root);
    await writeFile(join(root, "policy.toml"), '[host_guard]\nmode = "warn"\n', { mode: 0o600 });
    await withHeadroomHome(root, async () => { await expect(readHostGuardPolicy()).resolves.toMatchObject({ mode: "warn" }); });
  });
});

describe("hostGuardRefusal / hostGuardWarning", () => {
  const refuseHealth: HostHealth = { state: "refuse", reasons: ["load_ratio 4.00 exceeds host_guard.refuse_load_ratio (3)"], load_ratio: 4, pty_used: null, pty_max: null, orphans: null };
  const warnHealth: HostHealth = { state: "warn", reasons: ["load_ratio 2.50 exceeds host_guard.warn_load_ratio (2)"], load_ratio: 2.5, pty_used: null, pty_max: null, orphans: null };
  const okHealth: HostHealth = { state: "ok", reasons: [], load_ratio: 0.1, pty_used: null, pty_max: null, orphans: null };
  const unknownHealth: HostHealth = { state: "unknown", reasons: ["no host pressure measurements available on this platform"], load_ratio: null, pty_used: null, pty_max: null, orphans: null };

  it("refuses only for state refuse under mode refuse", () => {
    expect(hostGuardRefusal(refuseHealth, "refuse")).toContain("load_ratio 4.00");
    expect(hostGuardRefusal(refuseHealth, "warn")).toBeUndefined();
    expect(hostGuardRefusal(refuseHealth, "off")).toBeUndefined();
    expect(hostGuardRefusal(warnHealth, "refuse")).toBeUndefined();
    expect(hostGuardRefusal(okHealth, "refuse")).toBeUndefined();
    expect(hostGuardRefusal(unknownHealth, "refuse")).toBeUndefined();
  });

  it("names the measurement and the policy key in the refusal text", () => {
    const reason = hostGuardRefusal(refuseHealth, "refuse");
    expect(reason).toContain("host_guard.refuse_load_ratio");
  });

  it("warns for state warn regardless of mode (except off), and for a downgraded refuse under mode warn", () => {
    expect(hostGuardWarning(warnHealth, "refuse")).toContain("load_ratio 2.50");
    expect(hostGuardWarning(warnHealth, "warn")).toContain("load_ratio 2.50");
    expect(hostGuardWarning(warnHealth, "off")).toBeUndefined();
    expect(hostGuardWarning(refuseHealth, "warn")).toContain("load_ratio 4.00"); // still surfaced, even though run() will not refuse
    expect(hostGuardWarning(refuseHealth, "refuse")).toBeUndefined(); // refusal handles this case instead
  });

  it("never warns for ok or unknown, at any mode", () => {
    for (const mode of ["off", "warn", "refuse"] as const) {
      expect(hostGuardWarning(okHealth, mode)).toBeUndefined();
      expect(hostGuardWarning(unknownHealth, mode)).toBeUndefined();
    }
  });

  it("mode off silences everything, even a refuse-worthy reading", () => {
    expect(hostGuardRefusal(refuseHealth, "off")).toBeUndefined();
    expect(hostGuardWarning(refuseHealth, "off")).toBeUndefined();
  });
});
