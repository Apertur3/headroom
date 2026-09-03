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

export interface ProviderAccount {
  name: string;
  vendor: "codex" | "claude" | "antigravity";
  location: string;
  adapter: "codexbar" | "native" | "pending";
}

/** A local pool is declared now; its probe adapter lands in slice 5. */
export interface LocalAccount {
  name: string;
  kind: "local";
  base_url: string;
  wake?: string;
  adapter: "pending";
}

export type Account = ProviderAccount | LocalAccount;

export function isLocalAccount(account: Account): account is LocalAccount {
  return "kind" in account && account.kind === "local";
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
  /** Non-secret vendor facts used only for change detection. */
  metadata?: {
    plan?: string | null;
    free_resets_available?: number | null;
  };
}

export type PaceState = "HARVEST" | "NORMAL" | "CONSERVE" | "FREEZE" | "UNKNOWN";

export interface StoredObservation extends Observation {
  id: number;
}

export type EventKind = "reset_seen" | "free_reset_granted" | "free_reset_used" | "credits_changed" | "plan_changed" | "source_failed" | "source_recovered";

export interface TallyEvent {
  id: string;
  kind: EventKind;
  origin: "vendor_reported" | "inferred";
  confidence: number;
  evidence_observation_ids: number[];
  created_at: string;
  corrected_by: string | null;
  meter_id: string | null;
  principal_id: string | null;
}
