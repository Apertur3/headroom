import type { CreditReading, Reading, WindowReading } from "../../types.js";
import { redact } from "../../security.js";

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function windowFrom(value: unknown): WindowReading | null {
  if (!isObject(value)) return null;
  const used = number(value.usedPercent ?? value.used_percent);
  if (used === null) return null;
  return {
    used_percent: used,
    resets_at: string(value.resetsAt ?? value.reset_at ?? value.resets_at),
    window_minutes: number(value.windowMinutes ?? value.window_minutes),
  };
}

function unknownKeys(prefix: string, object: JsonObject, known: string[]): string[] {
  return Object.keys(object).filter((key) => !known.includes(key)).map((key) => `${prefix}.${key}`);
}

function creditsFrom(value: unknown): { available: number | null; credits: CreditReading[]; unmapped: string[] } {
  if (!isObject(value)) return { available: null, credits: [], unmapped: [] };
  const credits = Array.isArray(value.credits) ? value.credits.flatMap((credit) => {
    if (!isObject(credit)) return [];
    return [{ status: string(credit.status), expires_at: string(credit.expires_at ?? credit.expiresAt) }];
  }) : [];
  return {
    available: number(value.availableCount ?? value.available_count),
    credits,
    // Deliberately preserve names, not values: an unknown API field might contain a credential.
    unmapped: unknownKeys("usage.codexResetCredits", value, ["availableCount", "available_count", "credits", "updatedAt"]),
  };
}

export function adaptCodexPayload(payload: unknown, account: string, sampledAt = new Date().toISOString()): Reading[] {
  const candidates = Array.isArray(payload) ? payload : [payload];
  const item = candidates.find((candidate) => isObject(candidate) && candidate.provider === "codex");
  if (!isObject(item)) throw new Error("CodexBar payload did not contain a Codex provider result");
  if (isObject(item.error)) throw new Error(redact(string(item.error.message) || "CodexBar provider failed"));
  const usage = item.usage;
  if (!isObject(usage)) throw new Error("CodexBar Codex result did not contain usage");

  const truth: Reading["truth"] = item.source === "oauth" || item.source === "web" ? "official" : "estimated";
  const creditData = creditsFrom(usage.codexResetCredits);
  const unmapped = [
    ...unknownKeys("payload", item, ["provider", "source", "usage", "version", "credits", "accountPlan", "error"]),
    ...unknownKeys("usage", usage, ["accountEmail", "codexResetCredits", "dataConfidence", "identity", "loginMethod", "primary", "secondary", "tertiary", "updatedAt", "extraRateWindows"]),
    ...creditData.unmapped,
  ];
  const common = {
    account,
    vendor: "codex" as const,
    plan: string(usage.loginMethod),
    source: "engine:codexbar" as const,
    truth,
    sampled_at: sampledAt,
    extras: { free_resets_available: creditData.available, credits: creditData.credits, unmapped },
  };
  const primary = windowFrom(usage.primary);
  const secondary = windowFrom(usage.secondary);
  const readings: Reading[] = [{
    ...common,
    pool: "main",
    windows: {
      ...(primary ? { five_hour: primary } : {}),
      ...(secondary ? { weekly: secondary } : {}),
    },
  }];
  if (Array.isArray(usage.extraRateWindows)) {
    const spark = usage.extraRateWindows.filter(isObject).filter((entry) => string(entry.title)?.startsWith("Codex Spark"));
    if (spark.length) {
      const windows: Reading["windows"] = {};
      for (const entry of spark) {
        const parsed = windowFrom(entry.window ?? entry);
        if (!parsed) continue;
        if (parsed.window_minutes === 300 || /5.hour/i.test(string(entry.title) || "")) windows.five_hour = parsed;
        else if (parsed.window_minutes === 10080 || /week/i.test(string(entry.title) || "")) windows.weekly = parsed;
      }
      readings.push({ ...common, pool: "spark", windows });
    }
  }
  return readings;
}
