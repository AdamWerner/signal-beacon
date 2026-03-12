import { FeatureAggregator } from '../features/aggregator.js';
import { FusionInputs, TradeDirection } from '../fusion/types.js';
import { StreamingStore } from '../storage/streaming-store.js';
import { StreamingHealthService } from './streaming-health-service.js';
import { StreamingSymbolMap } from './symbol-map.js';

export class StreamingFeatureService {
  private cache = new Map<string, { at: number; payload: FusionInputs | null }>();

  constructor(
    private aggregator: FeatureAggregator,
    private store: StreamingStore,
    private symbolMap: StreamingSymbolMap,
    private health: StreamingHealthService,
    private staleMs: number
  ) {}

  getLatestFeatureSnapshot(symbol: string) {
    return this.aggregator.getLatest1s(symbol.toUpperCase()) || this.store.getLatestSnapshot(symbol.toUpperCase());
  }

  getLatestFeatureSnapshot1m(symbol: string) {
    return this.aggregator.getLatest1m(symbol.toUpperCase()) || this.store.getLatestSnapshot1m(symbol.toUpperCase());
  }

  getFusionInputsForAsset(
    params: {
      signalId: string;
      assetId: string;
      assetName: string;
      directionHint: TradeDirection;
      signalConfidence: number;
      signalDeltaPct: number;
      macroTag?: string;
      futuresTag?: string;
      volatilityTag?: string;
      executionTag?: string;
      secondVenueEnabled: boolean;
      liquidationEnabled: boolean;
    }
  ): FusionInputs | null {
    const cacheKey = `${params.signalId}:${params.assetId}:${params.directionHint}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < 1_000) {
      return cached.payload;
    }

    const mapping = this.symbolMap.getByAssetId(params.assetId);
    if (!mapping) {
      this.cache.set(cacheKey, { at: Date.now(), payload: null });
      return null;
    }
    const feature1s = this.getLatestFeatureSnapshot(mapping.binanceSymbol);
    const feature1m = this.getLatestFeatureSnapshot1m(mapping.binanceSymbol);

    const newestTs = feature1s?.timestamp ? Date.parse(feature1s.timestamp) : 0;
    const stale = !newestTs || Date.now() - newestTs > this.staleMs || !this.health.isHealthy();
    const payload: FusionInputs = {
      signalId: params.signalId,
      assetId: params.assetId,
      assetName: params.assetName,
      symbol: mapping.binanceSymbol,
      direction: params.directionHint,
      signalConfidence: params.signalConfidence,
      signalDeltaPct: params.signalDeltaPct,
      feature1s: feature1s || null,
      feature1m: feature1m || null,
      macroTag: params.macroTag,
      futuresTag: params.futuresTag,
      volatilityTag: params.volatilityTag,
      executionTag: params.executionTag,
      secondVenueEnabled: params.secondVenueEnabled,
      liquidationEnabled: params.liquidationEnabled,
      stale
    };

    this.cache.set(cacheKey, { at: Date.now(), payload });
    return payload;
  }

  getStreamingHealth() {
    return this.store.getStreamingHealth();
  }

  getLatestLeaderLag(symbol: string) {
    return this.store.getLatestLeaderLag(symbol.toUpperCase());
  }

  getLatestLiquidationContext(symbol: string) {
    const snapshot = this.getLatestFeatureSnapshot(symbol.toUpperCase());
    if (!snapshot) return null;
    return {
      burstIntensity: snapshot.liquidationBurstIntensity || 0,
      direction: snapshot.liquidationDirection || 'none',
      clustering: snapshot.liquidationClustering || 0
    };
  }
}
