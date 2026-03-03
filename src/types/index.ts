export interface Signal {
  id: string;
  timestamp: string;
  market_title: string;
  odds_before: number;
  odds_now: number;
  delta_pct: number;
  time_window: string;
  whale_detected: boolean;
  whale_amount: number;
  action: string;
  instrument: string;
  avanza_url: string;
  reasoning: string;
  confidence: number;
  direction: "bull" | "bear";
  status: "new" | "reviewed" | "expired";
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
  polarity: "DIRECT" | "INVERSE";
}

export interface WhaleEntry {
  id: string;
  timestamp: string;
  market: string;
  amount: number;
  direction: "YES" | "NO";
  odds_impact: number;
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
