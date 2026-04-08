export type SourceCatalystType =
  | 'finviz_news'
  | 'rss_news'
  | 'finviz_insider'
  | 'finviz_volume'
  | 'technical_breakout'
  | 'econ_surprise'
  | 'congressional_trade'
  | 'sec_insider';

export interface SourceCatalyst {
  sourceType: SourceCatalystType;
  sourceKey: string;
  ticker: string;
  assetId: string;
  assetName: string;
  title: string;
  body: string;
  directionHint: 'bull' | 'bear' | 'neutral';
  urgency: 'high' | 'medium' | 'low';
  timestamp: string;
  metadata?: Record<string, unknown>;
  sourceWeight?: number;
}

export interface IngestedCatalyst extends SourceCatalyst {
  catalystId: number;
  sourceFamily: string;
  eventType: string;
  horizonMinutes: number;
  causalStrength: number;
  noveltyScore: number;
  sourceQualityScore: number;
  normalizedSummary: string;
}
