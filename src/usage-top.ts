/**
 * `headroom usage top`: the attribution view from issue #53 item 6 --
 * "points per session or lane over a window, top spenders first" -- built on
 * top of the already-learned rates from `headroom rates` (rates-cli.ts /
 * rate-learner.ts) and `usage.db`'s imported per-identity token counts. This
 * command never fits or persists a rate itself; a model with no fit yet
 * (`headroom rates` has not been run, or it refused for insufficient data)
 * shows `estimated_points: null`, never a fabricated number.
 *
 * "session" here means `usage.db`'s own `--job` alias (the closest existing
 * lane/session concept it tracks -- see usage-store.ts's
 * `usage_identity_jobs`); usage with no bound `--job` (or a conflicted one)
 * rolls up under the fixed label `unattributed`, the same vocabulary the
 * spend ledger already uses for unowned movement (see `quota_spend`'s
 * description in mcp.ts).
 *
 * Local-only: no vendor fetch, no daemon RPC.
 */
import { HeadroomStore } from "./store.js";
import { UsageStore, type RateFitRow } from "./usage-store.js";
import { withContract } from "./json-contract.js";

export const USAGE_TOP_HELP = "Usage: headroom usage top [--window 5h|wk] [--by session|model] [--principal <id>] [--json]";

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function shortHash(key: string): string {
  return key.slice(0, 8);
}

interface TokenTotals {
  fresh_input: number;
  cache_read: number;
  cache_write: number;
  output: number;
}

function emptyTotals(): TokenTotals {
  return { fresh_input: 0, cache_read: 0, cache_write: 0, output: 0 };
}

function pointsFor(tokens: TokenTotals, fit: RateFitRow): number {
  const rate = fit.ratePerMillion;
  return (tokens.fresh_input * rate.fresh_input + tokens.cache_read * rate.cache_read + tokens.cache_write * rate.cache_write + tokens.output * rate.output) / 1_000_000;
}

export interface TopRow {
  principalId: string;
  /** The job hash (truncated for the human view, full in `--json`) this
   * row's usage was bound to at import time, or `"unattributed"` when no
   * `--job` was recorded -- present only when `by === "session"`. */
  sessionLabel?: string;
  /** The single model this row is scoped to, when `by === "model"`. */
  model?: string;
  /** Every model that contributed tokens to this row, regardless of `by`:
   * a `by: "session"` row can list more than one. */
  models: string[];
  identityCount: number;
  tokens: TokenTotals;
  /** `null` when at least one contributing model has no rate fit yet --
   * never a partial number silently missing part of the row's real usage. */
  estimatedPoints: number | null;
}

/**
 * Builds one row per (job, model) pair from `rows`, then rolls those pairs
 * up by the requested dimension (`model`, or `session` == job). Each pair's
 * tokens convert to points via `rateByModel`'s fit for that pair's model;
 * a rollup with any pair lacking a fit reports `estimatedPoints: null`
 * rather than silently under-counting.
 */
export function computeTopRows(
  principalId: string,
  rows: readonly { jobKey: string | null; model: string; freshInput: number; cacheRead: number; cacheWrite: number; output: number }[],
  by: "session" | "model",
  rateByModel: ReadonlyMap<string, RateFitRow>,
): TopRow[] {
  const pairs = new Map<string, { jobKey: string | null; model: string; tokens: TokenTotals; identityCount: number }>();
  for (const row of rows) {
    const key = `${row.jobKey ?? "\u0000"}\u0001${row.model}`;
    const entry = pairs.get(key) ?? { jobKey: row.jobKey, model: row.model, tokens: emptyTotals(), identityCount: 0 };
    entry.tokens.fresh_input += row.freshInput;
    entry.tokens.cache_read += row.cacheRead;
    entry.tokens.cache_write += row.cacheWrite;
    entry.tokens.output += row.output;
    entry.identityCount += 1;
    pairs.set(key, entry);
  }

  const rollups = new Map<string, TopRow>();
  for (const pair of pairs.values()) {
    const rollupKey = by === "model" ? pair.model : (pair.jobKey ?? "unattributed");
    const row = rollups.get(rollupKey) ?? {
      principalId,
      ...(by === "session" ? { sessionLabel: rollupKey } : { model: pair.model }),
      models: [],
      identityCount: 0,
      tokens: emptyTotals(),
      estimatedPoints: 0,
    };
    if (!row.models.includes(pair.model)) row.models.push(pair.model);
    row.tokens.fresh_input += pair.tokens.fresh_input;
    row.tokens.cache_read += pair.tokens.cache_read;
    row.tokens.cache_write += pair.tokens.cache_write;
    row.tokens.output += pair.tokens.output;
    row.identityCount += pair.identityCount;
    const fit = rateByModel.get(pair.model);
    row.estimatedPoints = fit && row.estimatedPoints !== null ? row.estimatedPoints + pointsFor(pair.tokens, fit) : null;
    rollups.set(rollupKey, row);
  }
  return [...rollups.values()];
}

function windowMinutesFor(label: string): number {
  if (label === "5h") return 300;
  if (label === "wk") return 10_080;
  throw new Error("--window must be 5h or wk");
}

function humanLine(row: TopRow): string {
  const parts = [`principal=${row.principalId}`];
  if (row.sessionLabel !== undefined) parts.push(`session=${row.sessionLabel === "unattributed" ? "unattributed" : shortHash(row.sessionLabel)}`);
  if (row.model !== undefined) parts.push(`model=${row.model}`);
  else parts.push(`models=${row.models.join(",")}`);
  parts.push(
    `identities=${row.identityCount}`,
    `freshInput=${row.tokens.fresh_input}`, `cacheRead=${row.tokens.cache_read}`, `cacheWrite=${row.tokens.cache_write}`, `output=${row.tokens.output}`,
    `estPoints=${row.estimatedPoints === null ? "unknown" : row.estimatedPoints.toFixed(2)}`,
  );
  return parts.join(" ");
}

function jsonRow(row: TopRow): Record<string, unknown> {
  return {
    principal_id: row.principalId,
    ...(row.sessionLabel !== undefined ? { session: row.sessionLabel } : {}),
    ...(row.model !== undefined ? { model: row.model } : { models: row.models }),
    identity_count: row.identityCount,
    tokens: row.tokens,
    estimated_points: row.estimatedPoints,
  };
}

export async function usageTopCommand(argv: string[]): Promise<number> {
  const asJson = argv.includes("--json");
  const windowLabel = option(argv, "--window") ?? "5h";
  const windowMinutes = windowMinutesFor(windowLabel);
  const by = option(argv, "--by") === "session" ? "session" : "model";
  const principalFilter = option(argv, "--principal");

  let headroomStore: HeadroomStore | undefined;
  let usageStore: UsageStore | undefined;
  try {
    headroomStore = await HeadroomStore.open();
    usageStore = await UsageStore.open({ create: false });
    if (!usageStore) {
      if (asJson) console.log(JSON.stringify(withContract({ rows: [], window: windowLabel, by, estimate_note: "no usage.db yet; run headroom usage import first" })));
      else console.log("no usage data imported yet (headroom usage import has not been run)");
      return 0;
    }

    const latestByWindow = headroomStore.latestPerWindow();
    const principals = [...new Set(
      latestByWindow
        .filter((observation) => observation.quantity?.unit === "percent" && observation.window?.minutes === windowMinutes)
        .filter((observation) => principalFilter === undefined || observation.principal_id === principalFilter)
        .map((observation) => `${observation.principal_id}\u0001${observation.meter_id}`),
    )].map((key) => { const [principalId, meterId] = key.split("\u0001"); return { principalId, meterId }; });

    const sinceMs = Date.now() - windowMinutes * 60_000;
    const rows: TopRow[] = [];
    for (const { principalId, meterId } of principals) {
      const principalKeyHash = usageStore.hashAlias("principal", principalId);
      const meterKeyHash = usageStore.hashAlias("meter", `${meterId}:${windowMinutes}`);
      const rateByModel = new Map<string, RateFitRow>();
      for (const fit of usageStore.latestRateFits({ principalKeyHash })) if (fit.meterKey === meterKeyHash) rateByModel.set(fit.model, fit);
      const usageRows = usageStore.claudeUsageRows({ principalKeyHash, sinceMs });
      rows.push(...computeTopRows(principalId, usageRows, by, rateByModel));
    }
    rows.sort((a, b) => (b.estimatedPoints ?? -1) - (a.estimatedPoints ?? -1));
    headroomStore.audit("cli", "usage_top", principalFilter ?? null, "ok");

    if (asJson) {
      console.log(JSON.stringify(withContract({ rows: rows.map(jsonRow), window: windowLabel, by, estimate_note: "estimates from headroom rates' learned rates; not vendor-billed truth" })));
      return 0;
    }
    if (!rows.length) { console.log(`no imported usage for window ${windowLabel}`); return 0; }
    for (const row of rows) console.log(humanLine(row));
    console.log("(estimates from `headroom rates`' learned rates; not vendor-billed truth)");
    return 0;
  } finally {
    usageStore?.close();
    headroomStore?.close();
  }
}
