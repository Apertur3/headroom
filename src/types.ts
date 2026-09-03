export type Truth = "official" | "estimated";

export interface WindowReading {
  used_percent: number;
  resets_at: string | null;
  window_minutes: number | null;
}

export interface CreditReading {
  status: string | null;
  expires_at: string | null;
}

export interface Reading {
  account: string;
  vendor: "codex";
  pool: "main" | "spark";
  plan: string | null;
  source: "engine:codexbar";
  truth: Truth;
  sampled_at: string;
  windows: Partial<Record<"five_hour" | "weekly", WindowReading>>;
  extras: {
    free_resets_available: number | null;
    credits: CreditReading[];
    unmapped: string[];
  };
}

export interface Account {
  name: string;
  vendor: "codex" | "claude" | "antigravity";
  location: string;
  adapter: "codexbar" | "native" | "pending";
}

/** v0.2 observation emitted by tally-engine and normalized from the fallback engine. */
export interface Observation {
  principal_id: string;
  meter_id: string;
  window: { kind: "rolling" | "fixed"; minutes: number | null; enforcement: "hard" | "soft" } | null;
  quantity: { used: number; limit: number; remaining: number; unit: "percent" | "tokens" | "requests" | "credits" } | null;
  resets_at: string | null;
  observed_at: string;
  fetched_at: string;
  source: string;
  truth: Truth;
  freshness: "fresh" | "stale" | "failed";
  confidence: number;
  adapter_version: string;
  upstream_schema_version: string;
  reason?: string | null;
}
