import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  escapeHtml,
  formatHumanPercent,
  determineDefaultSelection,
  htmlReportCommand,
  isLiveValidSample,
  processWindow,
  renderBrowserReport,
  renderRemainingCapacityChartSvg,
  safeJsonSerialize,
  sameReset,
  sanitizeFailureReason,
  splitSegments,
  writeBrowserReport,
  type ProcessedPoint,
  type ProcessedWindow,
} from "../src/browser-report.js";
import { defaultPolicy } from "../src/policy.js";
import type { DashboardModel } from "../src/dashboard.js";
import type { Observation } from "../src/types.js";

const fixedNow = new Date("2026-09-16T12:00:00.000Z");

function sampleObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    principal_id: "claude-main",
    meter_id: "claude-main:all",
    window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" },
    resets_at: "2026-09-16T16:00:00.000Z",
    observed_at: "2026-09-16T11:59:30.000Z",
    fetched_at: "2026-09-16T11:59:30.000Z",
    source: "native:claude",
    truth: "official",
    freshness: "fresh",
    confidence: 1,
    adapter_version: "1.0",
    upstream_schema_version: "1.0",
    burn_percent_per_hour: 4,
    sustainable_percent_per_hour: 20,
    metadata: { plan: "Max" },
    ...overrides,
  };
}

function sampleModel(overrides: Partial<DashboardModel> = {}): DashboardModel {
  return {
    now: fixedNow,
    version: "0.2.0",
    direct: false,
    policy: { ...defaultPolicy, reserve: { "claude-main:all": 10 } },
    vendors: new Map([["claude-main", "claude"]]),
    observations: [
      sampleObservation(),
      sampleObservation({
        window: { kind: "rolling", minutes: 10080, enforcement: "hard" },
        quantity: { used: 45, limit: 100, remaining: 55, unit: "percent" },
        resets_at: "2026-09-20T12:00:00.000Z",
        observed_at: "2026-09-16T11:59:00.000Z",
        fetched_at: "2026-09-16T11:59:00.000Z",
      }),
      sampleObservation({
        principal_id: "codex-main",
        meter_id: "codex-main:main",
        window: { kind: "fixed", minutes: 300, enforcement: "hard" },
        quantity: { used: 85, limit: 100, remaining: 15, unit: "percent" },
        resets_at: "2026-09-16T14:00:00.000Z",
        observed_at: "2026-09-16T11:58:00.000Z",
        fetched_at: "2026-09-16T11:58:00.000Z",
      }),
      sampleObservation({
        principal_id: "gpu-box",
        meter_id: "gpu-box:capacity",
        window: { kind: "state", minutes: null, enforcement: "hard" },
        quantity: null,
        resets_at: null,
        observed_at: "2026-09-16T11:55:00.000Z",
        fetched_at: "2026-09-16T11:55:00.000Z",
        metadata: { state: "BUSY", model_ids: ["qwen-27b"], running: 3, waiting: 1, cost_model: "marginal" },
      }),
      sampleObservation({
        principal_id: "claude-main",
        meter_id: "claude-main:credits",
        window: { kind: "count", minutes: null, enforcement: "soft" },
        quantity: { used: 0, limit: 50, remaining: 25, unit: "credits" },
        resets_at: "2026-10-01T00:00:00.000Z",
        observed_at: "2026-09-16T11:50:00.000Z",
        fetched_at: "2026-09-16T11:50:00.000Z",
      }),
    ],
    burns: { "claude-main:all:300": [1, 2, 3] },
    resetSeen: {},
    events: [
      {
        id: "ev-1",
        kind: "reset_seen",
        created_at: "2026-09-16T11:00:00.000Z",
        principal_id: "claude-main",
        meter_id: "claude-main:all",
        reason: null,
        origin: "vendor_reported",
        confidence: 1,
        evidence_observation_ids: [],
        corrected_by: null,
        last_seen_at: null,
        metadata: {},
      },
    ],
    leases: [
      {
        id: "lease-1",
        owner: "test-agent",
        meter_id: "claude-main:all",
        expected_percent: 10,
        spent_percent: 2.5,
        started_at: "2026-09-16T11:30:00.000Z",
        expires_at: "2026-09-16T12:30:00.000Z",
        ended_at: null,
        ended_reason: null,
        note: "safe unit test lease",
        action_class: "claude-fable",
      },
    ],
    notices: ["Unscheduled reset detected on codex-main; capacity refreshed."],
    planDowngraded: [],
    history: {
      "claude-main:all": [
        sampleObservation({
          observed_at: "2026-09-16T11:15:00.000Z",
          quantity: { used: 5, limit: 100, remaining: 95, unit: "percent" },
        }),
        sampleObservation({
          observed_at: "2026-09-16T11:30:00.000Z",
          quantity: { used: 12, limit: 100, remaining: 88, unit: "percent" },
        }),
        sampleObservation({
          observed_at: "2026-09-16T11:45:00.000Z",
          quantity: { used: 18, limit: 100, remaining: 82, unit: "percent" },
        }),
      ],
    },
    ...overrides,
  };
}

describe("browser report pure renderer", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of tempDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    tempDirs = [];
  });

  it("produces a complete, standalone HTML document without external assets or telemetry", () => {
    const model = sampleModel();
    const html = renderBrowserReport(model);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("</html>");
    expect(html).toContain("Headroom");
    expect(html).toContain("Subscription capacity");

    // Strictly standalone: NO external scripts or remote stylesheets
    expect(html).not.toMatch(/<script\s+[^>]*src=/i);
    expect(html).not.toMatch(/<link\s+[^>]*href=["']https?:/i);
    expect(html).not.toMatch(/google-analytics|googletagmanager|telemetry/i);

    // Embeds system typography
    expect(html).toContain("-apple-system");
    expect(html).toContain("ui-monospace");

    // Contains dark/light theme support
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("data-theme=\"dark\"");
    expect(html).toContain("data-theme=\"light\"");
    expect(html).toContain("id=\"theme-toggle\"");

    // Contains overview table and next scheduled reset
    expect(html).toContain("class=\"meter-overview-table\"");
    expect(html).toContain("Next scheduled reset:");
    expect(html).toContain("claude-main:all");
    expect(html).toContain("class=\"meter-row selected\"");
    expect(html).toContain("class=\"window-tab active\"");

    // Contains diagnostics section with active leases and events
    expect(html).toContain("test-agent");
    expect(html).toContain("safe unit test lease");
    expect(html).toContain("reset_seen");

    // Contains exact single formatted date and ISO in tooltip
    expect(html).toContain(model.now.toISOString());
  });

  it("handles an empty model gracefully without throwing or producing Invalid Date", () => {
    const emptyModel: DashboardModel = {
      now: fixedNow,
      version: "0.2.0",
      direct: true,
      policy: defaultPolicy,
      vendors: new Map(),
      observations: [],
      burns: {},
      resetSeen: {},
      events: [],
      leases: [],
      notices: [],
      planDowngraded: [],
    };

    const html = renderBrowserReport(emptyModel);
    expect(html).toContain("Headroom");
    expect(html).toContain("v0.2.0");
    expect(html).toContain("No subscription meters recorded");
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("NaN");
  });

  it("safely escapes HTML characters in dynamic data to prevent XSS and hides raw secrets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    expect(escapeHtml("Tom & Jerry \"quotes\"")).toBe("Tom &amp; Jerry &quot;quotes&quot;");

    const maliciousModel = sampleModel({
      observations: [
        sampleObservation({
          principal_id: "<img src=x onerror=alert(1)>",
          meter_id: "<script>alert('meter')</script>",
          reason: "Auth error: Bearer sk-ant-secret1234567890abcdef and /Users/test/workspace/secret",
        }),
      ],
      notices: ["Notice with <script>alert(3)</script> and sk-proj-supersecretkey"],
      leases: [
        {
          id: "lease-xss",
          owner: "<script>alert('owner')</script>",
          meter_id: "safe:meter",
          expected_percent: 5,
          spent_percent: 1,
          started_at: "2026-09-16T11:00:00Z",
          expires_at: "2026-09-16T12:00:00Z",
          ended_at: null,
          ended_reason: null,
          note: "Note <b onmouseover=alert(4)>hover</b> with Bearer sk-proj-supersecretkey",
          action_class: "build",
        },
      ],
    });

    const html = renderBrowserReport(maliciousModel);

    // None of the malicious tags should be rendered raw
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b onmouseover=");

    // Escaped entities must be present
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;script&gt;alert");

    // Raw secrets must not be in output
    expect(html).not.toContain("sk-ant-secret1234567890abcdef");
    expect(html).not.toContain("sk-proj-supersecretkey");

    // Private filesystem paths must not be rendered raw
    expect(html).not.toContain("/Users/test/workspace/secret");
  });

  it("safely serializes embedded JSON metadata against script tag terminators", () => {
    const payload = {
      malicious: "</script><script>alert('pwn')</script>",
      htmlComment: "<!-- test -->",
      unicodeSeparators: "line\u2028separator\u2029paragraph",
    };

    const serialized = safeJsonSerialize(payload);
    expect(serialized).not.toContain("</script>");
    expect(serialized).not.toContain("<!--");
    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(serialized).toContain("\\u003c!--");
    expect(serialized).toContain("\\u2028");
    expect(serialized).toContain("\\u2029");

    const parsed = JSON.parse(serialized);
    expect(parsed.malicious).toBe("</script><script>alert('pwn')</script>");
  });

  it("does not use unsafe innerHTML in client scripts and guards localStorage", () => {
    const html = renderBrowserReport(sampleModel());
    expect(html).not.toMatch(/\.innerHTML\s*=/);
    expect(html).not.toMatch(/\.outerHTML\s*=/);
    // localStorage read must be guarded with try/catch for private browsing
    expect(html).toContain("try {");
    expect(html).toContain("localStorage.getItem(\"headroom-theme\")");
  });
});

describe("formatHumanPercent formatting", () => {
  it("formats percentages to max 1 decimal and strips trailing .0", () => {
    expect(formatHumanPercent(92.38459999999999)).toBe("92.4");
    expect(formatHumanPercent(20.0)).toBe("20");
    expect(formatHumanPercent(0)).toBe("0");
    expect(formatHumanPercent(100)).toBe("100");
    expect(formatHumanPercent(99.94)).toBe("99.9");
    expect(formatHumanPercent(99.96)).toBe("100");
    expect(formatHumanPercent(null)).toBe("—");
    expect(formatHumanPercent(undefined)).toBe("—");
    expect(formatHumanPercent(Number.NaN)).toBe("—");
  });
});

describe("determineDefaultSelection logic", () => {
  it("prefers trustworthy current-period with >= 2 points, prioritizing 5h", () => {
    const pwWeekly: ProcessedWindow = {
      principal_id: "claude-main",
      meter_id: "claude-main:all",
      meter_name: "all",
      window_label: "Weekly",
      window_kind: "rolling",
      window_minutes: 10080,
      enforcement: "hard",
      decision_state: "NORMAL",
      decision_reason: "within normal pace",
      freshness: "fresh",
      quantity: { used: 40, limit: 100, remaining: 60, unit: "percent" },
      used_percent: 40,
      remaining_percent: 60,
      resets_at: "2026-09-20T12:00:00Z",
      observed_at: "2026-09-16T11:59:00Z",
      fetched_at: "2026-09-16T11:59:00Z",
      burn_rate: 1,
      sustainable_rate: 2,
      reserve_percent: 0,
      is_local: false,
      is_credits: false,
      is_not_enforced: false,
      is_unknown: false,
      current_points: [
        { at: 1, observed_at: "t1", resets_at: "r1", reset: 1, used: 30, remaining: 70, freshness: "fresh", confidence: 1 },
        { at: 2, observed_at: "t2", resets_at: "r1", reset: 1, used: 40, remaining: 60, freshness: "fresh", confidence: 1 },
      ],
      current_segments: [],
      insufficient_data: false,
      events: [],
    };

    const pw5h: ProcessedWindow = {
      ...pwWeekly,
      window_label: "5-Hour",
      window_minutes: 300,
      current_points: [
        { at: 1, observed_at: "t1", resets_at: "r2", reset: 2, used: 10, remaining: 90, freshness: "fresh", confidence: 1 },
        { at: 2, observed_at: "t2", resets_at: "r2", reset: 2, used: 20, remaining: 80, freshness: "fresh", confidence: 1 },
      ],
    };

    // When both weekly and 5h have >= 2 points, 5h is chosen
    const sel = determineDefaultSelection([pwWeekly, pw5h]);
    expect(sel).toEqual({ meter_id: "claude-main:all", window_minutes: 300 });

    // When only weekly has >= 2 points, weekly is chosen
    const pw5hSingle = { ...pw5h, current_points: [pw5h.current_points[0]] };
    const selWeekly = determineDefaultSelection([pwWeekly, pw5hSingle]);
    expect(selWeekly).toEqual({ meter_id: "claude-main:all", window_minutes: 10080 });

    // When neither has >= 2 points, fresh 5h with >= 1 point is chosen
    const pwWeeklySingle = { ...pwWeekly, current_points: [pwWeekly.current_points[0]] };
    const selFresh5h = determineDefaultSelection([pwWeeklySingle, pw5hSingle]);
    expect(selFresh5h).toEqual({ meter_id: "claude-main:all", window_minutes: 300 });
  });

  it("returns null or fallback when list is empty", () => {
    expect(determineDefaultSelection([])).toBeNull();
  });
});

describe("held and inconsistent vendor states", () => {
  it("treats vendor_window_held and vendor_inconsistent as unknown and does not show 0% live usage", () => {
    const heldObs = sampleObservation({
      quantity: { used: 0, limit: 100, remaining: 100, unit: "percent" },
      metadata: { vendor_window_held: true },
    });

    const model = sampleModel({ observations: [heldObs] });
    const pw = processWindow(heldObs, model, fixedNow);

    expect(pw.is_unknown).toBe(true);
    expect(pw.used_percent).toBeNull();
    expect(pw.remaining_percent).toBeNull();
    expect(pw.decision_state).toBe("UNKNOWN");
    expect(pw.decision_reason).toBe("New window unconfirmed, holding");

    const html = renderBrowserReport(model);
    expect(html).toContain("HELD");
    expect(html).toContain("New window unconfirmed, holding");
    expect(html).not.toMatch(/0% used/);
  });

  it("filters held or inconsistent windows out of next reset calculation", () => {
    const heldObs = sampleObservation({
      resets_at: "2026-09-16T12:05:00.000Z", // 5 mins in future, but held!
      metadata: { vendor_window_held: true },
    });

    const validObs = sampleObservation({
      principal_id: "valid-account",
      meter_id: "valid-account:all",
      resets_at: "2026-09-16T15:00:00.000Z", // 3 hours in future, valid!
    });

    const model = sampleModel({ observations: [heldObs, validObs] });
    const html = renderBrowserReport(model);

    // validObs must win the next reset, not heldObs
    expect(html).toContain("valid-account");
    expect(html).toContain("Next scheduled reset: <strong>valid-account");
  });
});

describe("chart scoping, gap splitting, resets, and jitter tolerance", () => {
  it("uses sameReset 60s tolerance to merge vendor timestamp jitter into same period", () => {
    expect(sameReset("2026-09-20T12:00:00.000Z", "2026-09-20T12:00:00.250Z")).toBe(true);
    expect(sameReset("2026-09-20T12:00:00.000Z", "2026-09-20T11:59:35.000Z")).toBe(true);
    expect(sameReset("2026-09-20T12:00:00.000Z", "2026-09-20T17:00:00.000Z")).toBe(false);

    // Live observation reset at 12:00:00.000Z
    const obs = sampleObservation({
      window: { kind: "rolling", minutes: 10080, enforcement: "hard" },
      resets_at: "2026-09-20T12:00:00.000Z",
      observed_at: "2026-09-16T11:59:00.000Z",
    });

    const model = sampleModel({
      observations: [obs],
      history: {
        "claude-main:all": [
          // History readings with minor vendor millisecond jitter
          sampleObservation({ window: { kind: "rolling", minutes: 10080, enforcement: "hard" }, resets_at: "2026-09-20T12:00:00.123Z", observed_at: "2026-09-16T11:15:00.000Z", quantity: { used: 5, limit: 100, remaining: 95, unit: "percent" } }),
          sampleObservation({ window: { kind: "rolling", minutes: 10080, enforcement: "hard" }, resets_at: "2026-09-20T12:00:00.456Z", observed_at: "2026-09-16T11:30:00.000Z", quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" } }),
          sampleObservation({ window: { kind: "rolling", minutes: 10080, enforcement: "hard" }, resets_at: "2026-09-20T11:59:59.000Z", observed_at: "2026-09-16T11:45:00.000Z", quantity: { used: 15, limit: 100, remaining: 85, unit: "percent" } }),
        ],
      },
    });

    const pw = processWindow(obs, model, fixedNow);
    // All 4 points must survive in the current window!
    expect(pw.current_points.length).toBe(4);
    expect(pw.insufficient_data).toBe(false);
  });

  it("splits segments on used decreases (quota reset/free reset/correction)", () => {
    const points: ProcessedPoint[] = [
      { at: 1000, observed_at: "2026-09-16T10:00:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 60, remaining: 40, freshness: "fresh", confidence: 1 },
      { at: 1000 + 5 * 60_000, observed_at: "2026-09-16T10:05:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 75, remaining: 25, freshness: "fresh", confidence: 1 },
      // Used dropped to 10% (reset granted!)
      { at: 1000 + 10 * 60_000, observed_at: "2026-09-16T10:10:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 10, remaining: 90, freshness: "fresh", confidence: 1 },
      { at: 1000 + 15 * 60_000, observed_at: "2026-09-16T10:15:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 15, remaining: 85, freshness: "fresh", confidence: 1 },
    ];

    const segments = splitSegments(points);
    expect(segments.length).toBe(2);
    expect(segments[0].length).toBe(2);
    expect(segments[1].length).toBe(2);
    expect(segments[0][1].used).toBe(75);
    expect(segments[1][0].used).toBe(10);
  });

  it("splits segments when time gap exceeds 15 minutes", () => {
    const points: ProcessedPoint[] = [
      { at: 1000, observed_at: "2026-09-16T10:00:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 10, remaining: 90, freshness: "fresh", confidence: 1 },
      { at: 1000 + 5 * 60_000, observed_at: "2026-09-16T10:05:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 15, remaining: 85, freshness: "fresh", confidence: 1 },
      // 20 minute gap (> 15 min threshold)
      { at: 1000 + 25 * 60_000, observed_at: "2026-09-16T10:25:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 20, remaining: 80, freshness: "fresh", confidence: 1 },
      { at: 1000 + 30 * 60_000, observed_at: "2026-09-16T10:30:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 25, remaining: 75, freshness: "fresh", confidence: 1 },
    ];

    const segments = splitSegments(points, 15 * 60_000);
    expect(segments.length).toBe(2);
    expect(segments[0].length).toBe(2);
    expect(segments[1].length).toBe(2);
  });

  it("splits segments across gap barriers created by failed or held observations", () => {
    const points: ProcessedPoint[] = [
      { at: 1000, observed_at: "2026-09-16T10:00:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 10, remaining: 90, freshness: "fresh", confidence: 1 },
      { at: 1000 + 4 * 60_000, observed_at: "2026-09-16T10:04:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 12, remaining: 88, freshness: "fresh", confidence: 1 },
      // Invalid / failed barrier observation at 10:08 (gap to next is only 4m, but barrier must split!)
      { at: 1000 + 8 * 60_000, observed_at: "2026-09-16T10:08:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 0, remaining: 0, freshness: "failed", confidence: 0, invalid: true },
      { at: 1000 + 12 * 60_000, observed_at: "2026-09-16T10:12:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 15, remaining: 85, freshness: "fresh", confidence: 1 },
      { at: 1000 + 16 * 60_000, observed_at: "2026-09-16T10:16:00Z", resets_at: "2026-09-16T16:00:00Z", reset: 50000, used: 18, remaining: 82, freshness: "fresh", confidence: 1 },
    ];

    const segments = splitSegments(points, 15 * 60_000);
    expect(segments.length).toBe(2);
    expect(segments[0].length).toBe(2);
    expect(segments[1].length).toBe(2);
    expect(segments[0][1].used).toBe(12);
    expect(segments[1][0].used).toBe(15);
  });

  it("processWindow splits segments when history contains a failed reading between valid readings", () => {
    const liveObs = sampleObservation({
      observed_at: "2026-09-16T11:50:00.000Z",
      quantity: { used: 30, limit: 100, remaining: 70, unit: "percent" },
      resets_at: "2026-09-16T16:00:00.000Z",
    });

    const model = sampleModel({
      observations: [liveObs],
      history: {
        "claude-main:all": [
          sampleObservation({
            observed_at: "2026-09-16T11:40:00.000Z",
            quantity: { used: 20, limit: 100, remaining: 80, unit: "percent" },
            resets_at: "2026-09-16T16:00:00.000Z",
          }),
          // Windowless failed probe 5 minutes later (gap to next is only 5m, but failed probe acts as barrier)
          sampleObservation({
            observed_at: "2026-09-16T11:45:00.000Z",
            freshness: "failed",
            quantity: null,
            resets_at: null,
            window: undefined,
          }),
        ],
      },
    });

    const pw = processWindow(liveObs, model, fixedNow);
    expect(pw.current_points.length).toBe(2);
    expect(pw.current_segments.length).toBe(2);
    expect(pw.current_segments[0].length).toBe(1);
    expect(pw.current_segments[1].length).toBe(1);
  });

  it("keeps charts strictly scoped to matching meter and window minutes", () => {
    const obs5h = sampleObservation({ meter_id: "claude-main:all", window: { kind: "rolling", minutes: 300, enforcement: "hard" } });
    const obsWk = sampleObservation({
      meter_id: "claude-main:all",
      window: { kind: "rolling", minutes: 10080, enforcement: "hard" },
      quantity: { used: 45, limit: 100, remaining: 55, unit: "percent" },
      resets_at: "2026-09-20T12:00:00.000Z",
    });
    const obsFable = sampleObservation({ meter_id: "claude-main:fable", window: { kind: "rolling", minutes: 300, enforcement: "hard" } });

    const model: DashboardModel = sampleModel({
      observations: [obs5h, obsWk, obsFable],
      history: {
        "claude-main:all": [
          sampleObservation({
            meter_id: "claude-main:all",
            window: { kind: "rolling", minutes: 300, enforcement: "hard" },
            observed_at: "2026-09-16T11:00:00.000Z",
            quantity: { used: 10, limit: 100, remaining: 90, unit: "percent" },
          }),
          sampleObservation({
            meter_id: "claude-main:all",
            window: { kind: "rolling", minutes: 10080, enforcement: "hard" },
            observed_at: "2026-09-16T11:00:00.000Z",
            quantity: { used: 50, limit: 100, remaining: 50, unit: "percent" },
            resets_at: "2026-09-20T12:00:00.000Z",
          }),
        ],
      },
    });

    const pw5h = processWindow(obs5h, model, fixedNow);
    const pwWk = processWindow(obsWk, model, fixedNow);
    const pwFable = processWindow(obsFable, model, fixedNow);

    expect(pw5h.current_points.length).toBe(2);
    expect(pw5h.current_points.every((p) => p.used === 10 || p.used === 20)).toBe(true);
    expect(pwWk.current_points.length).toBe(2);
    expect(pwWk.current_points.every((p) => p.used === 50 || p.used === 45)).toBe(true);
    expect(pwFable.current_points.length).toBe(1);
  });

  it("only plots real reset and free-reset events on the chart, ignoring non-reset events", () => {
    const obs = sampleObservation({ meter_id: "claude-main:all", resets_at: "2026-09-16T16:00:00Z" });
    const model = sampleModel({
      observations: [obs],
      events: [
        { id: "e1", kind: "reset_seen", created_at: "2026-09-16T11:30:00Z", meter_id: "claude-main:all", origin: "vendor_reported", confidence: 1, evidence_observation_ids: [], corrected_by: null, last_seen_at: null, metadata: {} },
        { id: "e2", kind: "free_reset_used", created_at: "2026-09-16T11:45:00Z", meter_id: "claude-main:all", origin: "inferred", confidence: 1, evidence_observation_ids: [], corrected_by: null, last_seen_at: null, metadata: {} },
        { id: "e3", kind: "source_failed", created_at: "2026-09-16T11:35:00Z", meter_id: "claude-main:all", origin: "inferred", confidence: 1, evidence_observation_ids: [], corrected_by: null, last_seen_at: null, metadata: {} },
        { id: "e4", kind: "lease_started", created_at: "2026-09-16T11:40:00Z", meter_id: "claude-main:all", origin: "direct", confidence: 1, evidence_observation_ids: [], corrected_by: null, last_seen_at: null, metadata: {} },
      ],
    });

    const pw = processWindow(obs, model, fixedNow);
    expect(pw.events.length).toBe(2);
    expect(pw.events.map((e) => e.kind)).toEqual(["reset_seen", "free_reset_used"]);

    const svg = renderRemainingCapacityChartSvg(pw, fixedNow);
    expect(svg).toContain(">R<");
    expect(svg).toContain(">F<");
  });
});

describe("unknown data, invalid samples, and special meter handling", () => {
  it("excludes failed, stale, held, and idle placeholder samples as live samples", () => {
    expect(isLiveValidSample(sampleObservation({ freshness: "fresh" }))).toBe(true);
    expect(isLiveValidSample(sampleObservation({ freshness: "failed" }))).toBe(false);
    expect(isLiveValidSample(sampleObservation({ freshness: "stale" }))).toBe(false);
    expect(isLiveValidSample(sampleObservation({ metadata: { vendor_window_held: true } }))).toBe(false);
    expect(isLiveValidSample(sampleObservation({ metadata: { vendor_inconsistent: true } }))).toBe(false);
    expect(isLiveValidSample(sampleObservation({ truth: "estimated", reason: "vendor reports an idle window; reset equals fetch time plus window length, so this may be a placeholder" }))).toBe(false);
  });

  it("does not silently make missing quota zero and sanitizes failure reasons", () => {
    expect(sanitizeFailureReason("Error: Keychain grant needed /Users/test/.credentials")).toBe("Credential access required");
    expect(sanitizeFailureReason("Rate limit 429 backoff")).toBe("Rate limit backoff");
    expect(sanitizeFailureReason("arbitrary unknown provider message")).toBe("Reading unavailable; run headroom doctor");
    expect(sanitizeFailureReason(null)).toBe("Reading unavailable; run headroom doctor");

    const obs = sampleObservation({
      quantity: null,
      freshness: "failed",
      reason: "Keychain grant needed /Users/test/.credentials",
      last_known: {
        used_percent: 42,
        observed_at: "2026-09-16T10:00:00Z",
        age_seconds: 7200,
        resets_at: null,
      },
    });

    const model = sampleModel({ observations: [obs] });
    const pw = processWindow(obs, model, fixedNow);

    expect(pw.used_percent).toBeNull();
    expect(pw.remaining_percent).toBeNull();
    expect(pw.is_unknown).toBe(true);

    const html = renderBrowserReport(model);
    expect(html).toContain("UNKNOWN");
    expect(html).not.toContain("0% remaining");
    expect(html).toContain("Credential access required");
    expect(html).not.toContain("/Users/test/.credentials");
  });

  it("handles local pools intelligibly without percentage quota charts", () => {
    const poolObs = sampleObservation({
      principal_id: "gpu-box",
      meter_id: "gpu-box:capacity",
      window: { kind: "state", minutes: null, enforcement: "hard" },
      quantity: null,
      resets_at: null,
      metadata: { state: "BUSY", model_ids: ["local-27b", "llama-70b"], running: 4, waiting: 2, cost_model: "marginal" },
    });

    const model = sampleModel({ observations: [poolObs] });
    const pw = processWindow(poolObs, model, fixedNow);

    expect(pw.is_local).toBe(true);

    const html = renderBrowserReport(model);
    expect(html).toContain("Local Pool Concurrency");
    expect(html).toContain("local-27b, llama-70b");
    expect(html).toContain("Running Requests");
    expect(html).toContain("Waiting Queue Depth");
    expect(html).toContain("They do not enforce percent quota windows.");
  });

  it("handles credits intelligibly without percentage quota charts", () => {
    const creditObs = sampleObservation({
      principal_id: "codex-main",
      meter_id: "codex-main:credits",
      window: { kind: "count", minutes: null, enforcement: "soft" },
      quantity: { used: 0, limit: 100, remaining: 34, unit: "credits" },
      resets_at: "2026-10-15T00:00:00Z",
    });

    const model = sampleModel({ observations: [creditObs] });
    const pw = processWindow(creditObs, model, fixedNow);

    expect(pw.is_credits).toBe(true);

    const html = renderBrowserReport(model);
    expect(html).toContain("Available Balance");
    expect(html).toContain("34 credits");
    expect(html).toContain("Soft enforcement");
    expect(html).toContain("Credits are informational counts");
  });
});

describe("file output, atomic write safety, and CLI wiring", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "headroom-report-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("writes report with mode 0600 restrictive permissions", async () => {
    const target = join(tempDir, "report.html");
    const model = sampleModel();

    const result = await writeBrowserReport(target, model);
    expect(result.path).toBe(target);
    expect(result.bytes).toBeGreaterThan(1000);

    const content = await readFile(target, "utf8");
    expect(content).toContain("Headroom");

    const fileStat = await stat(target);
    if (process.platform !== "win32") {
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  it("atomically refuses to overwrite existing destination by default unless force is true", async () => {
    const target = join(tempDir, "existing-report.html");
    await writeFile(target, "initial content", "utf8");

    const model = sampleModel();

    // Must atomically refuse without overwriting
    await expect(writeBrowserReport(target, model)).rejects.toThrow(/Refusing to overwrite existing file/);

    // Verify existing content was not touched
    const untouched = await readFile(target, "utf8");
    expect(untouched).toBe("initial content");

    // Overwrites when force: true
    const result = await writeBrowserReport(target, model, { force: true });
    expect(result.path).toBe(target);

    const replaced = await readFile(target, "utf8");
    expect(replaced).toContain("<!DOCTYPE html>");
  });

  it("refuses to write through a symlink destination", async () => {
    if (process.platform === "win32") return;

    const realTarget = join(tempDir, "real.html");
    await writeFile(realTarget, "real", "utf8");

    const linkPath = join(tempDir, "symlink-report.html");
    await symlink(realTarget, linkPath);

    const model = sampleModel();
    await expect(writeBrowserReport(linkPath, model, { force: true })).rejects.toThrow(/Refusing to write through symlink/);
  });

  it("htmlReportCommand validates arguments and prints target path on success", async () => {
    const target = join(tempDir, "cli-report.html");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => { logs.push(msg); });

    await expect(htmlReportCommand(["--html"])).rejects.toThrow(/Usage: headroom dashboard --html <path>/);
    await expect(htmlReportCommand(["--html", "--force"])).rejects.toThrow(/Usage: headroom dashboard --html <path>/);

    const code = await htmlReportCommand(["--html", target]);
    expect(code).toBe(0);
    expect(logs).toContain(target);

    const fileStat = await lstat(target);
    expect(fileStat.isFile()).toBe(true);
  });
});
