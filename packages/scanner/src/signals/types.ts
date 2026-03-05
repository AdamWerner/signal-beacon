export interface GeneratedSignal {
  id: string;
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
  polarity: 'direct' | 'inverse' | 'context_dependent';
  suggested_action: string;
  suggested_instruments: Array<{
    name: string;
    avanza_id: string;
    leverage: number | null;
    avanza_url: string;
  }>;
  reasoning: string;
  confidence: number;
  requires_judgment: boolean;
  deduplication_key: string;
  verification_status: 'pending' | 'approved' | 'rejected' | 'needs_review';
  verification_score: number;
  verification_reason: string;
  verification_flags: string[];
  verification_source: string;
  verification_record: string | null;
}
