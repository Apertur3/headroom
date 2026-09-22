/**
 * CLI-facing wiring for `headroom usage import` / `headroom usage
 * import-status`: parses flags (usage-import-options.ts), drives one bounded
 * capture run (usage-collector.ts) against the opt-in `usage.db`
 * (usage-store.ts), and renders both the human and `--json` views.
 *
 * Never prints a raw file path or a raw `--source`/`--principal`/`--job`
 * alias: every identifier surfaced here is either a fixed, code-defined
 * reason string or one of usage-store.ts's own opaque per-database hashes
 * (full 32-hex in `--json`; truncated only for the human view, and only
 * there, since a human never disambiguates two cursors by hash anyway).
 */
import { parseUsageImportOptions } from "./usage-import-options.js";
import { CollectInputError, collectUsageFile, type CollectResult } from "./usage-collector.js";
import { NewerUsageSchemaError, UsageStateError, UsagePersistenceError, UsageStore, type CursorRow, type GroupedTotal, type InterruptReason, type SafeSum } from "./usage-store.js";

export const USAGE_IMPORT_HELP =
  "Usage: headroom usage import --source <alias> --principal <alias> --path <file> [--job <alias>] [--max-bytes N] [--format auto|claude|codex] [--json]";
export const USAGE_IMPORT_STATUS_HELP = "Usage: headroom usage import-status [--json]";

/** Independent of json-contract.ts's `JSON_CONTRACT_VERSION`: these two
 * commands are not (yet) documented in docs/json-contract.md, so their
 * output must not claim coverage by that contract. A future doc pass can
 * fold this into the real envelope; until then it carries its own label. */
const USAGE_IMPORT_JSON_VERSION = "1";

/** Fixed coverage/evidence markers stamped on every import and import-status
 * output (including the no-data-yet case): what is counted here is only
 * whatever files an operator explicitly imported (never a whole account or
 * a whole session), and a counted message is only known to have been
 * *visible in a transcript*, never confirmed as vendor-settled billing. */
const COVERAGE = {
  coverage: "imported_files_only",
  account_coverage: "unknown",
  evidence: "message_visible",
  evidence_note: "message visible in a transcript; not confirmed as vendor-settled usage",
} as const;

/** A generic, fixed message for any error this layer did not already turn
 * into a safe, reason-based one above -- never the original error's own
 * message, which could otherwise carry a raw OS error (and, on some
 * platforms, the path that triggered it). */
const GENERIC_IMPORT_FAILURE = "usage import failed";
const GENERIC_STATUS_FAILURE = "usage import-status failed";

function jsonEnvelope<T extends object>(payload: T, now: Date): T & { version: string; generated_at: string } {
  return { ...payload, version: USAGE_IMPORT_JSON_VERSION, generated_at: now.toISOString() };
}

/** Human display only -- every JSON field carries the full opaque hash, so
 * two cursors, sources or principals never collide for a machine reader. */
function shortHash(key: string): string {
  return key.slice(0, 8);
}

const CAPTURE_REASON_TEXT: Readonly<Record<CollectInputError["reason"], string>> = {
  not_found: "the file at --path does not exist",
  is_directory: "--path points at a directory, not a file",
  not_regular_file: "--path is not a regular file",
  symlink_refused: "--path is a symlink; point --path at the real file",
  parent_symlink_refused: "a directory in --path's ancestry is a symlink not owned by root",
  unsafe_ownership: "the file at --path is not owned by the current user",
  unsafe_permissions: "the file at --path is group- or world-writable",
  unsafe_ancestry: "a parent directory of --path is unsafe (symlinked or unowned)",
  changed_before_read: "the file at --path changed between being checked and being opened",
};

const INTERRUPT_REASON_TEXT: Readonly<Record<InterruptReason, string>> = {
  boundary_changed: "file content changed just behind the last committed position",
  changed_during_scan: "the file changed while this run was still reading it",
  concurrent_update: "another import run committed a write to this cursor first",
};

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/** True only once nothing is left for a re-invocation to pick up: end of
 * file was reached, no oversized-line discard is still in progress, no
 * trailing line without its closing newline was left uncommitted, and the
 * run did not stop early because it hit `--max-bytes`. Any one of those
 * still pending means the same command re-invoked with the same arguments
 * has more to do, even though this run itself succeeded. */
function isFinished(result: CollectResult): boolean {
  return result.kind === "imported" && result.atEof && !result.discardPending && !result.pendingPartial && !result.budgetExhausted;
}

/** `format` is display-only (it never changes what already ran): Codex's
 * counter vocabulary is exactly the collector's own generic `kind=count`
 * pairs (`accepted_new`, `skipped:rate_limit_only`, `rejected:missing_usage`,
 * ...), so no extra rendering is needed for it beyond labeling the run --
 * unlike import-status's grouped totals, which do carry Codex-only counter
 * columns (see `totalHumanLine`). `"auto"` labels the run as detected
 * per-line (see usage-format-detect.ts); which vendor(s) it actually found
 * is visible from the counters line below (a Codex-shaped line always bumps
 * a Codex-vocabulary counter, and vice versa). */
function importHumanLines(result: CollectResult, format: "claude" | "codex" | "auto" = "claude"): string[] {
  const lines: string[] = [];
  const cursor = shortHash(result.cursorKey);
  if (result.kind === "principal_conflict" || result.kind === "source_conflict") {
    const dimension = result.kind === "principal_conflict" ? "--principal" : "--source";
    lines.push(`refused: cursor ${cursor} is already bound to a different ${dimension}`);
    lines.push(`fix the ${dimension} value to match what this file was first imported under -- do not switch to a new alias just to force this through, or the same lines get double-counted under two bindings`);
    return lines;
  }
  if (result.kind === "interrupted") {
    const reasonText = result.interruptReason ? INTERRUPT_REASON_TEXT[result.interruptReason] : "an unspecified interruption";
    lines.push(`interrupted: cursor ${cursor} -- ${reasonText}; investigate before re-running`);
    return lines;
  }
  const formatNote = format === "codex" || format === "auto" ? ` format=${format}` : "";
  lines.push(`imported: cursor ${cursor} generation=${result.generation} bytesRead=${result.bytesReadThisRun}${formatNote} ${isFinished(result) ? "(finished)" : "(not finished -- re-run to continue)"}`);
  if (!isFinished(result)) {
    const pending: string[] = [];
    if (!result.atEof) pending.push("more bytes remain unread");
    if (result.pendingPartial) pending.push("a trailing line has no newline yet");
    if (result.budgetExhausted) pending.push("the byte or line limit was reached this run");
    if (result.discardPending) pending.push("an oversized line is still being discarded");
    if (pending.length) lines.push(`pending: ${pending.join("; ")}`);
  }
  if (result.jobConflict) lines.push("refused: --job does not match the job already bound to this cursor -- this run's job linkage is withheld (ambiguous), not recorded");
  if (result.jobConflictIdentities > 0) lines.push(`note: ${result.jobConflictIdentities} identit${result.jobConflictIdentities === 1 ? "y" : "ies"} already claimed by a different job lost that job association (flagged, not merged)`);
  const counterEntries = Object.entries(result.counters).filter(([, count]) => count > 0);
  if (counterEntries.length) lines.push(`counters: ${counterEntries.map(([kind, count]) => `${kind}=${count}`).join(" ")}`);
  return lines;
}

export async function usageImportCommand(argv: string[]): Promise<number> {
  const options = parseUsageImportOptions(argv);
  if (options.command !== "import") throw new Error(USAGE_IMPORT_HELP);

  let store: UsageStore | undefined;
  try {
    store = await UsageStore.open({ create: true });
    if (!store) throw new Error(GENERIC_IMPORT_FAILURE);

    const format: "claude" | "codex" | "auto" = options.format === "codex" ? "codex" : options.format === "auto" ? "auto" : "claude";
    const result = await collectUsageFile(store, {
      sourceAlias: options.source,
      principalAlias: options.principal,
      path: options.path,
      ...(options.job !== undefined ? { jobAlias: options.job } : {}),
      maxBytes: options.maxBytes,
      vendor: format,
    });

    if (options.json) {
      const payload = {
        kind: result.kind,
        cursorKey: result.cursorKey,
        generation: result.generation,
        byteOffset: result.byteOffset,
        bytesReadThisRun: result.bytesReadThisRun,
        atEof: result.atEof,
        pendingPartial: result.pendingPartial,
        budgetExhausted: result.budgetExhausted,
        discardPending: result.discardPending,
        jobConflict: result.jobConflict,
        jobConflictIdentities: result.jobConflictIdentities,
        interruptReason: result.interruptReason,
        finished: isFinished(result),
        format,
        counters: result.counters,
        ...COVERAGE,
      };
      console.log(JSON.stringify(jsonEnvelope(payload, new Date())));
    } else {
      for (const line of importHumanLines(result, format)) console.log(line);
      console.log(`(${COVERAGE.coverage}, account coverage ${COVERAGE.account_coverage}, evidence: ${COVERAGE.evidence_note})`);
    }
    return result.kind === "imported" ? 0 : 1;
  } catch (error) {
    if (error instanceof CollectInputError) throw new Error(CAPTURE_REASON_TEXT[error.reason]);
    if (error instanceof NewerUsageSchemaError || error instanceof UsageStateError || error instanceof UsagePersistenceError) throw new Error(error.message);
    throw new Error(GENERIC_IMPORT_FAILURE);
  } finally {
    store?.close();
  }
}

// ---------------------------------------------------------------------------
// import-status
// ---------------------------------------------------------------------------

function formatSafeSum(sum: SafeSum): string {
  if (sum.overflow) return "overflow";
  if (sum.known === 0) return "unknown";
  return sum.unknown > 0 ? `${sum.total} (missing ${sum.unknown})` : String(sum.total);
}

function totalHumanLine(total: GroupedTotal): string {
  const parts = [
    `vendor=${total.vendor}`,
    `source=${shortHash(total.sourceKey)}`,
    `principal=${shortHash(total.principalKey)}`,
    `model=${total.model}`,
    `identities=${total.identityCount}`,
    `input=${formatSafeSum(total.inputTokens)}`,
    `output=${formatSafeSum(total.outputTokens)}`,
  ];
  if (total.vendor === "codex") {
    // Codex's own counter vocabulary: cached/cache-write/reasoning/total
    // token counts have no Claude analogue, so they render here instead of
    // the Claude-only cache-read/cache-creation pair below.
    if (total.cachedInputTokens) parts.push(`cachedInput=${formatSafeSum(total.cachedInputTokens)}`);
    if (total.cacheWriteTokens) parts.push(`cacheWrite=${formatSafeSum(total.cacheWriteTokens)}`);
    if (total.reasoningTokens) parts.push(`reasoning=${formatSafeSum(total.reasoningTokens)}`);
    if (total.totalTokens) parts.push(`total=${formatSafeSum(total.totalTokens)}`);
  } else {
    parts.push(`cacheRead=${formatSafeSum(total.cacheReadInputTokens)}`);
    parts.push(`cacheCreation=${formatSafeSum(total.cacheCreationInputTokens)}`);
  }
  return parts.join(" ");
}

function cursorHumanLine(cursor: CursorRow): string {
  return [
    `cursor=${shortHash(cursor.cursorKey)}`,
    `source=${shortHash(cursor.sourceKey)}`,
    `principal=${shortHash(cursor.principalKey)}`,
    `status=${cursor.status}`,
    cursor.status === "interrupted" && cursor.interruptReason ? `interruptReason=${cursor.interruptReason}` : undefined,
    `lastScan=${cursor.lastScanAt ?? "never"}`,
    `bytesRead=${cursor.totalBytesRead}`,
    `atEof=${cursor.atEof}`,
    `pendingPartial=${cursor.pendingPartial}`,
    `budgetExhausted=${cursor.budgetExhausted}`,
    `discardPending=${cursor.discardPending}`,
    cursor.jobConflict ? "jobConflict=true" : undefined,
  ].filter((part): part is string => part !== undefined).join(" ");
}

/** Non-zero parse/rejection/skip counters across every cursor, summed by
 * kind -- so a file whose lines were mostly rejected (unknown model,
 * malformed JSON, oversized lines, ...) doesn't just silently show up as a
 * low identity count with no explanation. Never includes raw line content;
 * `kind` is one of usage-collector.ts's own fixed counter names. */
function summarizeCounters(rows: Array<{ kind: string; count: number }>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) totals[row.kind] = (totals[row.kind] ?? 0) + row.count;
  return totals;
}

export async function usageImportStatusCommand(argv: string[]): Promise<number> {
  const options = parseUsageImportOptions(argv);
  if (options.command !== "import-status") throw new Error(USAGE_IMPORT_STATUS_HELP);

  let store: UsageStore | undefined;
  try {
    // create:false: a status read must never bring a usage.db (or its home
    // directory) into existence.
    store = await UsageStore.open({ create: false });
    if (!store) {
      if (options.json) console.log(JSON.stringify(jsonEnvelope({ cursors: [], totals: [], quarantineCount: 0, counters: {}, ...COVERAGE }, new Date())));
      else {
        console.log("no usage data imported yet (headroom usage import has not been run)");
        console.log(`(${COVERAGE.coverage}, account coverage ${COVERAGE.account_coverage}, evidence: ${COVERAGE.evidence_note})`);
      }
      return 0;
    }

    const cursors = store.allCursors();
    const totals = store.groupedTotals();
    const quarantineCount = store.quarantineCount();
    const counters = summarizeCounters(store.counters());

    if (options.json) {
      const payload = {
        cursors: cursors.map((cursor) => ({
          cursorKey: cursor.cursorKey,
          sourceKey: cursor.sourceKey,
          principalKey: cursor.principalKey,
          jobKey: cursor.jobKey,
          jobConflict: cursor.jobConflict,
          status: cursor.status,
          interruptReason: cursor.interruptReason,
          generation: cursor.generation,
          byteOffset: cursor.byteOffset,
          atEof: cursor.atEof,
          pendingPartial: cursor.pendingPartial,
          budgetExhausted: cursor.budgetExhausted,
          discardPending: cursor.discardPending,
          totalBytesRead: cursor.totalBytesRead,
          lastScanAt: cursor.lastScanAt,
        })),
        totals,
        quarantineCount,
        counters,
        ...COVERAGE,
      };
      console.log(JSON.stringify(jsonEnvelope(payload, new Date())));
      return 0;
    }

    const interruptedCount = cursors.filter((cursor) => cursor.status === "interrupted").length;
    console.log(`cursors: ${cursors.length} (${interruptedCount} interrupted)`);
    console.log(`quarantined identities: ${quarantineCount}`);
    console.log("(hash ids below are local, per-database opaque aliases -- never the raw --source/--principal/--job value passed in)");
    console.log("");
    console.log("Totals by source/principal/model:");
    if (!totals.length) console.log("  (none imported yet)");
    else for (const total of totals) console.log(`  ${totalHumanLine(total)}`);
    console.log("");
    console.log("Cursors:");
    if (!cursors.length) console.log("  (none)");
    else for (const cursor of cursors) console.log(`  ${cursorHumanLine(cursor)}`);
    const counterEntries = Object.entries(counters).filter(([, count]) => count > 0);
    console.log("");
    console.log("Parse/rejection counters:");
    if (!counterEntries.length) console.log("  (none)");
    else for (const [kind, count] of counterEntries) console.log(`  ${kind}=${count}`);
    console.log("");
    console.log(`(${COVERAGE.coverage}, account coverage ${COVERAGE.account_coverage}, evidence: ${COVERAGE.evidence_note})`);
    return 0;
  } catch (error) {
    if (error instanceof NewerUsageSchemaError || error instanceof UsageStateError || error instanceof UsagePersistenceError) throw new Error(error.message);
    throw new Error(GENERIC_STATUS_FAILURE);
  } finally {
    store?.close();
  }
}
