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
  /** `native-ts` is credential-local TypeScript; `engine` is the optional Swift engine. */
  adapter: "codexbar" | "native" | "native-ts" | "engine" | "pending";
  /** Optional explicit agy executable for the daemon-owned warm local probe. */
  agy_path?: string;
}

/** A local pool is a probed OpenAI-compatible capacity source. */
export interface LocalAccount {
  name: string;
  kind: "local";
  base_url: string;
  wake?: string;
  adapter: "native";
}

export type Account = ProviderAccount | LocalAccount;

export function isLocalAccount(account: Account): account is LocalAccount {
  return "kind" in account && account.kind === "local";
}

/** v0.2 observation emitted by headroom-engine and normalized from the fallback engine. */
export interface Observation {
  principal_id: string;
  meter_id: string;
  window: { kind: "rolling" | "fixed" | "count" | "state"; minutes: number | null; enforcement: "hard" | "soft" } | null;
  quantity: { used: number; limit: number | null; remaining: number | null; unit: "percent" | "tokens" | "requests" | "credits" } | null;
  resets_at: string | null;
  observed_at: string;
  fetched_at: string;
  source: string;
  truth: Truth;
  /** `not_enforced` is a vendor-confirmed absent limit, not an unknown read. */
  freshness: "fresh" | "stale" | "failed" | "not_enforced";
  confidence: number;
  adapter_version: string;
  upstream_schema_version: string;
  reason?: string | null;
  /** Non-secret vendor facts used only for change detection. */
  metadata?: {
    plan?: string | null;
    free_resets_available?: number | null;
    /** Local-pool facts. They deliberately contain no credentials or prompts. */
    state?: "UP" | "BUSY" | "DOWN";
    model_ids?: string[];
    running?: number;
    waiting?: number;
    cost_model?: "sunk" | "marginal";
  };
  /** Computed, never persisted: least-squares burn rate from this window's
   * fresh samples in the last lookback minutes (60 by default), the
   * projected time to 100% used at that rate, and the straight-line percent
   * per hour that would exactly spend the remaining allowance by reset.
   * Present once a caller has enriched the observation via pace.ts;
   * undefined on a raw vendor reading or a stored row read back verbatim. */
  burn_percent_per_hour?: number | null;
  empty_in_seconds?: number | null;
  sustainable_percent_per_hour?: number | null;
}

export type PaceState = "HARVEST" | "NORMAL" | "CONSERVE" | "FREEZE" | "UNKNOWN" | "NOT_ENFORCED" | "UP" | "BUSY" | "DOWN";

export interface StoredObservation extends Observation {
  id: number;
}

export type EventKind = "reset_seen" | "free_reset_granted" | "free_reset_used" | "credits_changed" | "plan_changed" | "source_failed" | "source_recovered" | "lease_started" | "lease_ended" | "pace_projection_conserve";

export interface Lease {
  id: string;
  owner: string;
  meter_id: string;
  expected_percent: number | null;
  note: string | null;
  /** Set by `lease start --class <name>` or by `can --lease`; groups this
   * lease's eventual spend into store.learnedCost()'s per-class statistics. */
  action_class: string | null;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  spent_percent: number;
  /** Returned by an idempotent end request; never persisted. */
  already_ended?: boolean;
}

export interface HeadroomEvent {
  id: string;
  kind: EventKind;
  origin: "vendor_reported" | "inferred";
  confidence: number;
  evidence_observation_ids: number[];
  created_at: string;
  corrected_by: string | null;
  meter_id: string | null;
  principal_id: string | null;
  reason: string | null;
  /** For an open source_failed event, the most recent poll that still found
   * the same failure; updated in place instead of appending a new event
   * while a principal stays down. Null for every other event kind. */
  last_seen_at: string | null;
}
