export type TradeDirection = 'bull' | 'bear';

export interface FeatureSnapshot1s {
  timestamp: string;
  symbol: string;
  topImbalance: number;
  multiLevelImbalance: number;
  ofiProxy: number;
  microPrice: number;
  midPrice: number;
  microDivergence: number;
  normalizedMicroDivergence: number;
  spreadBps: number;
  depth10bps: number;
  depth25bps: number;
  depthDropRate: number;
  liquidityCliff: boolean;
  tradeIntensity: number;
  signedTradeImbalance: number;
  shortVolatilityPct: number;
  liquidationBurstIntensity?: number;
  liquidationDirection?: 'buy' | 'sell' | 'mixed' | 'none';
  liquidationClustering?: number;
  secondVenueReturn5s?: number;
  secondVenueGapBps?: number;
}

export interface FeatureSnapshot1m {
  timestamp: string;
  symbol: string;
  topImbalanceAvg: number;
  multiLevelImbalanceAvg: number;
  ofiAvg: number;
  microDivergenceAvg: number;
  spreadBpsAvg: number;
  depth10bpsAvg: number;
  tradeIntensityAvg: number;
  signedTradeImbalanceAvg: number;
  shortVolatilityPctAvg: number;
  topImbalancePersistenceBull: number;
  topImbalancePersistenceBear: number;
  microDivergencePersistenceBull: number;
  microDivergencePersistenceBear: number;
  imbalanceZScore: number;
  ofiZScore: number;
  regimeLabel: string;
}

export interface FusionInputs {
  signalId: string;
  assetId: string;
  assetName: string;
  symbol: string;
  direction: TradeDirection;
  signalConfidence: number;
  signalDeltaPct: number;
  feature1s: FeatureSnapshot1s | null;
  feature1m: FeatureSnapshot1m | null;
  macroTag?: string;
  futuresTag?: string;
  volatilityTag?: string;
  executionTag?: string;
  secondVenueEnabled: boolean;
  liquidationEnabled: boolean;
  stale: boolean;
}

export interface FusionDecision {
  signalId: string;
  timestamp: string;
  assetId: string;
  symbol: string;
  direction: TradeDirection;
  pHat: number;
  expectancyHatPct: number;
  hardPass: boolean;
  softScore: number;
  reasons: string[];
  suppressReasons: string[];
  featureFlagsUsed: string[];
  decision: 'allow' | 'suppress' | 'fallback_phase1';
}

