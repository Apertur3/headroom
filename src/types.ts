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
  vendor: "codex" | "claude";
  location: string;
  adapter: "codexbar" | "pending";
}
