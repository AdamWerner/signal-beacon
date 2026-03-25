export interface Signal {
  id: string;
  signal_origin?: "polymarket" | "catalyst_convergence" | "hybrid";
  timestamp: string;
  market_condition_id: string;
  market_slug: string;
  market_title: string;
  odds_before: number;
  odds_now: number;
  delta_pct: number;
  time_window_minutes: number;
  whale_detected: boolean;
  whale_amount_usd: number | null;
  matched_asset_id: string;
  matched_asset_name: string;
  polarity: "direct" | "inverse" | "context_dependent";
  suggested_action: string;
  suggested_instruments: Array<{
    name: string;
    avanza_id: string;
    leverage: number | null;
    avanza_url: string;
  }>;
  reasoning: string;
  confidence: number;
  requires_judgment?: boolean;
  deduplication_key?: string;
  verification_status?: "pending" | "approved" | "rejected" | "needs_review";
  verification_score?: number;
  verification_reason?: string | null;
  verification_flags?: string[];
  verification_source?: string | null;
  verification_record?: string | null;
  primary_source_family?: string | null;
  catalyst_score?: number | null;
  catalyst_summary?: string | null;
  execution_replay_gate?: "open" | "watch" | "block" | "unknown" | null;
  execution_replay_expectancy_pct?: number | null;
  execution_replay_samples?: number | null;
  execution_replay_win_rate?: number | null;
  proxy?: boolean;
  proxy_source_signal_id?: string | null;
  also_affects?: string[];
  status: "new" | "viewed" | "dismissed" | "acted";
}

export interface Briefing {
  id: number;
  date: string;
  market: "swedish" | "us";
  briefing_generated_at: string | null;
  pushed_at: string | null;
  briefing_text: string;
  signal_count: number;
  top_assets: string[];
  url: string;
}

export interface MarketWatch {
  id: string;
  market: string;
  current_odds: number;
  change_24h: number;
  last_delta: number;
  whale_alert: boolean;
  status: "active" | "quiet" | "alert";
  sparkline: number[];
  history: { time: string; odds: number }[];
}

export interface Correlation {
  id: string;
  polymarket: string;
  polymarket_odds: number;
  instrument: string;
  instrument_type: "BULL" | "BEAR";
  polarity: "DIRECT" | "INVERSE" | "CONTEXT";
}

export interface WhaleEntry {
  id: string;
  timestamp: string;
  market: string;
  amount: number;
  direction: "YES" | "NO";
  price_at_trade: number | null;
}

export interface ScannerSettings {
  odds_threshold: number;
  time_window: number;
  whale_threshold: number;
  scan_interval: number;
}

export interface AlertChannel {
  name: string;
  enabled: boolean;
  fields: { label: string; value: string }[];
}

export interface HealthStatus {
  status: string;
  uptime: number;
  timestamp: string;
  last_scan_at: string | null;
  avanza: string;
  scanner: {
    markets: { total: number; active: number };
    signals: { total: number; new: number; viewed: number; acted: number; avg_confidence: number };
    instruments: { total: number };
  };
  jobs: {
    scan_cycle: { schedule: string };
    market_refresh: { schedule: string };
    instrument_refresh: { schedule: string; enabled: boolean };
    cleanup: { schedule: string };
  };
}
