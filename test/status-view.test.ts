import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPolicy } from "../src/policy.js";
import { explainUnknown, renderStatus, statusViewOptions, type StatusViewInput, type StatusViewOptions } from "../src/status-view.js";
import type { Lease, Observation } from "../src/types.js";

// Absolute reset times and credit expiries are formatted in the local zone,
// so the snapshots below are pinned to UTC and the ambient zone is restored
// afterwards -- test files share a worker process.
let originalTimezone: string | undefined;
beforeAll(() => { originalTimezone = process.env.TZ; process.env.TZ = "UTC"; });
afterAll(() => { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone; });

const NOW = new Date("2026-09-08T00:46:00Z");
const READ_AT = new Date(NOW.getTime() - 30_000).toISOString();

function at(minutesFromNow: number): string {
  return new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();
}

function observation(overrides: Partial<Observation> & Pick<Observation, "principal_id" | "meter_id">): Observation {
  return {
    window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used: 0, limit: 100, remaining: 100, unit: "percent" },
    resets_at: at(60),
    observed_at: READ_AT,
    fetched_at: READ_AT,
    source: "native:claude",
    truth: "official",
    freshness: "fresh",
    confidence: 1,
    adapter_version: "test",
    upstream_schema_version: "test",
    ...overrides,
  };
}

/** The fixed three-principal store every form below is rendered from: a
 * healthy Claude principal with two meters, a Codex principal whose only
 * meter is a credit balance, and a Gemini principal both of whose windows
 * are unknown for the same reason. */
const STORE: Observation[] = [
  observation({
    principal_id: "claude-main", meter_id: "claude-main:all",
    quantity: { used: 22, limit: 100, remaining: 78, unit: "percent" }, resets_at: at(194),
    metadata: { plan: "Max 20x" }, burn_percent_per_hour: 21, sustainable_percent_per_hour: 24, empty_in_seconds: 13_371,
  }),
  observation({
    principal_id: "claude-main", meter_id: "claude-main:all", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
    quantity: { used: 32, limit: 100, remaining: 68, unit: "percent" }, resets_at: at(8054),
    metadata: { plan: "Max 20x" }, burn_percent_per_hour: 4, sustainable_percent_per_hour: 0.6,
  }),
  observation({
    principal_id: "claude-main", meter_id: "claude-main:fable", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
    quantity: { used: 40, limit: 100, remaining: 60, unit: "percent" }, resets_at: at(8054),
    burn_percent_per_hour: 0, sustainable_percent_per_hour: 0.4,
  }),
  observation({
    principal_id: "codex-main", meter_id: "codex-main:credits", source: "native:codex",
    window: { kind: "count", minutes: null, enforcement: "hard" },
    quantity: { used: 0, limit: null, remaining: 2, unit: "credits" }, resets_at: "2026-10-04T12:00:00Z",
  }),
  observation({
    principal_id: "gemini", meter_id: "gemini:all", source: "remote:gemini", quantity: null, resets_at: null,
    freshness: "failed", reason: "Keychain grant needed; run: headroom keychain grant --principal gemini",
  }),
  observation({
    principal_id: "gemini", meter_id: "gemini:all", source: "remote:gemini", window: { kind: "fixed", minutes: 10_080, enforcement: "hard" },
    quantity: null, resets_at: null, freshness: "failed", reason: "Keychain grant needed; run: headroom keychain grant --principal gemini",
  }),
];

const VENDORS = new Map([["claude-main", "claude"], ["codex-main", "codex"], ["gemini", "gemini"]]);

function input(overrides: Partial<StatusViewInput> = {}): StatusViewInput {
  return { observations: STORE, policy: defaultPolicy, vendors: VENDORS, now: NOW, ...overrides };
}

function options(overrides: Partial<StatusViewOptions> = {}): StatusViewOptions {
  return { form: "grouped", verbose: false, color: false, width: 100, direct: false, ...overrides };
}

function render(viewOverrides: Partial<StatusViewOptions> = {}, dataOverrides: Partial<StatusViewInput> = {}): string {
  return renderStatus(input(dataOverrides), options(viewOverrides)).join("\n");
}

describe("status view: the three forms", () => {
  it("groups by principal, aligns the columns and puts the pace state last", () => {
    expect(render()).toMatchInlineSnapshot(`
      "claude-main  claude  Max 20x  fresh <1m
        all      5h  22% used  resets in 3h 14m  HARVEST
                 wk  32% used  resets in 5d 14h  CONSERVE
        fable    wk  40% used  resets in 5d 14h  CONSERVE

      codex-main  codex  fresh <1m
        credits  2 available, expire Oct 4

      gemini  gemini  failed <1m
        all      5h         -                    UNKNOWN
                 wk         -                    UNKNOWN
        UNKNOWN: macOS has not let Headroom read this account's credentials yet. Run: headroom keychain
        grant --principal gemini

      3 principals, 2 UNKNOWN (grant needed), daemon fresh <1m ago"
    `);
  });

  it("keeps burn, sustainable pace, the exact reset time and the reserve for --verbose only", () => {
    const plain = render();
    const verbose = render({ verbose: true });
    for (const detail of ["burn 21%/h", "sustainable 24%/h", "empty in 3h 42m", "resets at 04:00", "official via native:claude"]) {
      expect(plain).not.toContain(detail);
      expect(verbose).toContain(detail);
    }
    // The default line is unchanged by --verbose; the detail is an extra,
    // indented line underneath it, never a rewrite of the row above.
    expect(verbose).toContain("  all      5h  22% used  resets in 3h 14m  HARVEST\n      resets at 04:00,");
  });

  it("shows the reserve and the reset evidence under --verbose", () => {
    const view = render(
      { verbose: true },
      { policy: { ...defaultPolicy, reserve: { "claude-main:fable": 10 } }, resetSeen: new Map([["claude-main:all:300", at(-153)]]), freeResetUsed: new Map([["claude-main:all:10080", at(-153)]]) },
    );
    expect(view).toContain("reserve 10%");
    expect(view).toContain("reset seen Sep 7 22:13");
    expect(view).toContain("free reset Sep 7 22:13");
    expect(render()).not.toContain("reset seen");
  });

  it("prints the dense one-line-per-meter form under --plain, unchanged", () => {
    expect(render({ form: "plain" })).toMatchInlineSnapshot(`
      "claude-main:all  5h 22% ↻04:00 (in 3h 14m) HARVEST burn 21%/h, ok 24%/h | wk 32% ↻Sep 13 15:00 (in 5d 14h) CONSERVE burn 4%/h, ok 0.6%/h  (fresh <1m)
      claude-main:fable  wk 40% ↻Sep 13 15:00 (in 5d 14h) CONSERVE burn 0%/h, ok 0.4%/h  (fresh <1m)
      codex-main:credits  credits 2 available (expires Oct 4)  (fresh <1m)
      gemini:all  5h UNKNOWN (Keychain grant needed; run: headroom keychain grant --principal gemini) | wk UNKNOWN (Keychain grant needed; run: headroom keychain grant --principal gemini)  (failed <1m)"
    `);
  });

  it("gives the dense form no ANSI, no headers and exactly one line per meter", () => {
    const lines = renderStatus(input(), options({ form: "plain" }));
    const meters = new Set(STORE.map((item) => item.meter_id));
    expect(lines).toHaveLength(meters.size);
    for (const line of lines) {
      expect(line).not.toMatch(/\u001b\[/);
      // Every line starts with its own meter id: no principal header, no
      // footer prose, no blank separator for a parser to skip.
      expect([...meters].some((meter) => line.startsWith(`${meter}  `))).toBe(true);
    }
    expect(lines.join("\n")).not.toContain("principals");
  });
});

describe("status view: local pools and credits", () => {
  const pool = (state: "UP" | "DOWN", extra: Partial<Observation> = {}): Observation => observation({
    principal_id: "gpu-box", meter_id: "gpu-box:capacity", source: "native:local",
    window: { kind: "state", minutes: null, enforcement: "soft" }, resets_at: null,
    quantity: { used: 0, limit: null, remaining: null, unit: "requests" },
    metadata: { state, model_ids: ["coder"], running: 0, waiting: 0 },
    ...extra,
  });

  it("renders a running pool as one line naming its state, model and queue", () => {
    expect(render({}, { observations: [pool("UP")] })).toContain("gpu-box  UP  coder  0 running, 0 waiting");
  });

  it("renders a sleeping pool with the command that wakes it", () => {
    const down = pool("DOWN", { metadata: { state: "DOWN" }, reason: "connect refused; wake: ssh gateway wake-gpu-box" });
    expect(render({}, { observations: [down] })).toContain("gpu-box  DOWN  wake: ssh gateway wake-gpu-box");
  });

  it("renders a credit balance as a count and an expiry, with no pace state", () => {
    expect(render()).toContain("  credits  2 available, expire Oct 4");
  });
});

describe("status view: UNKNOWN in plain words", () => {
  it("says why and what to do, once per principal when the reason is shared", () => {
    const view = render();
    expect(view.match(/UNKNOWN: macOS has not let Headroom/g)).toHaveLength(1);
    expect(view.replace(/\n\s+/g, " ")).toContain("Run: headroom keychain grant --principal gemini");
  });

  it("says it per window when two windows are unknown for different reasons", () => {
    const observations = [
      STORE[4],
      { ...STORE[5], reason: "no daemon; Antigravity needs the daemon-kept agy: run headroom install-service" },
    ];
    const view = render({}, { observations });
    expect(view.replace(/\n\s+/g, " ")).toContain("UNKNOWN: macOS has not let Headroom read this account's credentials yet. Run: headroom keychain grant --principal gemini");
    expect(view.replace(/\n\s+/g, " ")).toContain("UNKNOWN: the daemon is not running, and Antigravity needs the daemon-kept agy. Run: headroom install-service");
  });

  it("translates each known reason into a cause and a remedy", () => {
    expect(explainUnknown("Keychain grant needed; run: headroom keychain grant --principal claude-main")).toEqual({
      cause: "grant needed",
      text: "macOS has not let Headroom read this account's credentials yet. Run: headroom keychain grant --principal claude-main",
    });
    expect(explainUnknown("stale 60m; next poll ~14:20")).toMatchObject({ cause: "stale" });
    expect(explainUnknown("stale 60m; next poll ~14:20").text).toContain("Run: headroom --refresh");
    expect(explainUnknown("no readings for codex-main:main")).toMatchObject({ cause: "never read" });
    expect(explainUnknown("Gemini CLI OAuth client unavailable")).toEqual({ cause: "read failed", text: "Gemini CLI OAuth client unavailable." });
  });
});

describe("status view: the footer", () => {
  it("counts principals and UNKNOWN windows, names the cause, and dates the daemon reading", () => {
    expect(render().split("\n").at(-1)).toBe("3 principals, 2 UNKNOWN (grant needed), daemon fresh <1m ago");
  });

  it("says so when the numbers came from a direct read instead of the daemon", () => {
    expect(render({ direct: true }).split("\n").at(-1)).toBe("3 principals, 2 UNKNOWN (grant needed), direct read, no daemon");
  });

  it("drops the UNKNOWN clause entirely when everything was read", () => {
    expect(render({}, { observations: STORE.slice(0, 4) }).split("\n").at(-1)).toBe("2 principals, daemon fresh <1m ago");
  });

  it("names an active lease under the meter that holds it", () => {
    const leases = new Map<string, Lease[]>([["claude-main:all", [{ id: "l1", owner: "ci", meter_id: "claude-main:all", expected_percent: null, note: null, action_class: null, started_at: READ_AT, expires_at: at(30), ended_at: null, ended_reason: null, spent_percent: 0 }]]]);
    expect(render({}, { leases })).toContain("      held by ci");
  });
});

describe("status view: widths", () => {
  const wide = STORE.map((item) => ({ ...item, principal_id: `${item.principal_id}-with-a-very-long-name`, meter_id: item.meter_id.replace(":", "-with-a-very-long-name:") }));

  it("keeps every line inside the terminal width", () => {
    for (const width of [80, 100, 120]) {
      for (const line of renderStatus(input({ observations: wide, vendors: undefined }), options({ width }))) expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it("drops the countdown to its largest unit before it truncates a name", () => {
    expect(render({ width: 100 })).toContain("resets in 3h 14m");
    const narrow = renderStatus(input(), options({ width: 50 })).join("\n");
    expect(narrow).toContain("resets in 3h");
    expect(narrow).not.toContain("resets in 3h 14m");
    expect(narrow).toContain("HARVEST");
  });

  it("still renders every row at the default width with no terminal to measure", () => {
    const lines = renderStatus(input(), options({ width: 100 }));
    expect(lines.filter((line) => line.includes("used"))).toHaveLength(3);
  });
});

describe("status view: form and colour selection", () => {
  it("is human-first on a TTY and dense everywhere else", () => {
    expect(statusViewOptions([], true, {})).toMatchObject({ form: "grouped", color: true });
    expect(statusViewOptions([], false, {})).toMatchObject({ form: "plain", color: false });
  });

  it("lets --agent and --plain force the dense form on a TTY, and --human force the grouped one in a pipe", () => {
    expect(statusViewOptions(["--agent"], true, {})).toMatchObject({ form: "plain", color: false });
    expect(statusViewOptions(["--plain"], true, {})).toMatchObject({ form: "plain", color: false });
    expect(statusViewOptions(["--human"], false, {})).toMatchObject({ form: "grouped" });
    expect(statusViewOptions(["--verbose"], false, {})).toMatchObject({ form: "grouped", verbose: true });
    expect(statusViewOptions(["-v"], false, {})).toMatchObject({ form: "grouped", verbose: true });
  });

  it("refuses to guess when the two are asked for at once", () => {
    expect(() => statusViewOptions(["--agent", "--human"], true, {})).toThrow(/cannot be combined/);
    expect(() => statusViewOptions(["--plain", "--verbose"], true, {})).toThrow(/dense one-line form/);
  });

  it("respects NO_COLOR, and --color still wins", () => {
    expect(statusViewOptions([], true, { NO_COLOR: "1" }).color).toBe(false);
    expect(statusViewOptions(["--color"], true, { NO_COLOR: "1" }).color).toBe(true);
    expect(statusViewOptions(["--color", "--no-color"], true, {}).color).toBe(false);
    // Colour is a property of the human view; the dense form never carries it.
    expect(statusViewOptions(["--agent", "--color"], true, {}).color).toBe(false);
  });

  it("paints only the pace state, and only when colour is on", () => {
    const painted = renderStatus(input(), options({ color: true }));
    expect(painted.find((line) => line.includes("22% used"))).toBe("  all      5h  22% used  resets in 3h 14m  \u001b[32mHARVEST\u001b[0m");
    expect(painted.find((line) => line.includes("32% used"))).toContain("\u001b[33mCONSERVE\u001b[0m");
    expect(painted.find((line) => line.startsWith("gemini  "))).not.toContain("\u001b[");
    expect(renderStatus(input(), options()).join("\n")).not.toContain("\u001b[");
  });

  it("takes the width from the terminal when it reports one", () => {
    expect(statusViewOptions([], true, {}, 132).width).toBe(132);
    expect(statusViewOptions([], true, {}, undefined).width).toBe(100);
    expect(statusViewOptions([], true, {}, 10).width).toBe(40);
  });
});
