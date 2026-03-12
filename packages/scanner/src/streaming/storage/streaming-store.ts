import Database from 'better-sqlite3';
import { FeatureSnapshot1m, FeatureSnapshot1s, FusionDecision } from '../fusion/types.js';

export class StreamingStore {
  constructor(private db: Database.Database) {}

  insertFeatureSnapshot1s(snapshot: FeatureSnapshot1s, assetId: string | null): void {
    this.db.prepare(`
      INSERT INTO feature_snapshots_1s (
        timestamp, symbol, asset_id, top_imbalance, multi_level_imbalance, ofi_proxy,
        micro_price, mid_price, micro_divergence, normalized_micro_divergence, spread_bps,
        depth_10bps, depth_25bps, depth_drop_rate, liquidity_cliff,
        trade_intensity, signed_trade_imbalance, short_volatility_pct,
        liquidation_burst_intensity, liquidation_direction, liquidation_clustering,
        second_venue_return_5s, second_venue_gap_bps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.timestamp,
      snapshot.symbol,
      assetId,
      snapshot.topImbalance,
      snapshot.multiLevelImbalance,
      snapshot.ofiProxy,
      snapshot.microPrice,
      snapshot.midPrice,
      snapshot.microDivergence,
      snapshot.normalizedMicroDivergence,
      snapshot.spreadBps,
      snapshot.depth10bps,
      snapshot.depth25bps,
      snapshot.depthDropRate,
      snapshot.liquidityCliff ? 1 : 0,
      snapshot.tradeIntensity,
      snapshot.signedTradeImbalance,
      snapshot.shortVolatilityPct,
      snapshot.liquidationBurstIntensity ?? null,
      snapshot.liquidationDirection ?? null,
      snapshot.liquidationClustering ?? null,
      snapshot.secondVenueReturn5s ?? null,
      snapshot.secondVenueGapBps ?? null
    );
  }

  insertFeatureSnapshot1m(snapshot: FeatureSnapshot1m, assetId: string | null): void {
    this.db.prepare(`
      INSERT INTO feature_snapshots_1m (
        timestamp, symbol, asset_id, top_imbalance_avg, multi_level_imbalance_avg, ofi_avg,
        micro_divergence_avg, spread_bps_avg, depth_10bps_avg, trade_intensity_avg,
        signed_trade_imbalance_avg, short_volatility_pct_avg,
        top_imbalance_persistence_bull, top_imbalance_persistence_bear,
        micro_divergence_persistence_bull, micro_divergence_persistence_bear,
        imbalance_zscore, ofi_zscore, regime_label
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.timestamp,
      snapshot.symbol,
      assetId,
      snapshot.topImbalanceAvg,
      snapshot.multiLevelImbalanceAvg,
      snapshot.ofiAvg,
      snapshot.microDivergenceAvg,
      snapshot.spreadBpsAvg,
      snapshot.depth10bpsAvg,
      snapshot.tradeIntensityAvg,
      snapshot.signedTradeImbalanceAvg,
      snapshot.shortVolatilityPctAvg,
      snapshot.topImbalancePersistenceBull,
      snapshot.topImbalancePersistenceBear,
      snapshot.microDivergencePersistenceBull,
      snapshot.microDivergencePersistenceBear,
      snapshot.imbalanceZScore,
      snapshot.ofiZScore,
      snapshot.regimeLabel
    );
  }

  insertLiquidityEvent(
    symbol: string,
    assetId: string | null,
    eventType: string,
    payload: Record<string, unknown>
  ): void {
    this.db.prepare(`
      INSERT INTO liquidity_events (timestamp, symbol, asset_id, event_type, payload)
      VALUES (datetime('now'), ?, ?, ?, ?)
    `).run(symbol, assetId, eventType, JSON.stringify(payload));
  }

  insertLiquidationEvent(
    symbol: string,
    assetId: string | null,
    side: 'buy' | 'sell',
    price: number,
    quantity: number,
    timestamp: string
  ): void {
    this.db.prepare(`
      INSERT INTO liquidation_events (timestamp, symbol, asset_id, side, price, quantity)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(timestamp, symbol, assetId, side, price, quantity);
  }

  insertLeaderLagSnapshot(
    symbol: string,
    assetId: string | null,
    primaryReturn5s: number,
    secondVenueReturn5s: number,
    gapBps: number
  ): void {
    this.db.prepare(`
      INSERT INTO leader_lag_snapshots (
        timestamp, symbol, asset_id, primary_return_5s, second_venue_return_5s, gap_bps
      ) VALUES (datetime('now'), ?, ?, ?, ?, ?)
    `).run(symbol, assetId, primaryReturn5s, secondVenueReturn5s, gapBps);
  }

  insertFusionDecision(decision: FusionDecision): void {
    this.db.prepare(`
      INSERT INTO fusion_decisions (
        timestamp, signal_id, asset_id, symbol, direction, p_hat, expectancy_hat_pct,
        hard_pass, soft_score, reasons_json, suppress_reasons_json, feature_flags_used_json, decision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.timestamp,
      decision.signalId,
      decision.assetId,
      decision.symbol,
      decision.direction,
      decision.pHat,
      decision.expectancyHatPct,
      decision.hardPass ? 1 : 0,
      decision.softScore,
      JSON.stringify(decision.reasons),
      JSON.stringify(decision.suppressReasons),
      JSON.stringify(decision.featureFlagsUsed),
      decision.decision
    );
  }

  insertSuppressedDecision(decision: FusionDecision): void {
    this.db.prepare(`
      INSERT INTO suppressed_decisions (
        timestamp, signal_id, asset_id, symbol, direction, p_hat, expectancy_hat_pct,
        suppress_reasons_json, reasons_json, feature_flags_used_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.timestamp,
      decision.signalId,
      decision.assetId,
      decision.symbol,
      decision.direction,
      decision.pHat,
      decision.expectancyHatPct,
      JSON.stringify(decision.suppressReasons),
      JSON.stringify(decision.reasons),
      JSON.stringify(decision.featureFlagsUsed)
    );
  }

  upsertHealth(component: string, status: string, details: string, lastMessageAt: string): void {
    this.db.prepare(`
      INSERT INTO streaming_health (component, status, details, last_message_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(component) DO UPDATE SET
        status = excluded.status,
        details = excluded.details,
        last_message_at = excluded.last_message_at,
        updated_at = datetime('now')
    `).run(component, status, details, lastMessageAt);
  }

  getLatestSnapshot(symbol: string): FeatureSnapshot1s | null {
    const row = this.db.prepare(`
      SELECT
        timestamp, symbol,
        top_imbalance as topImbalance,
        multi_level_imbalance as multiLevelImbalance,
        ofi_proxy as ofiProxy,
        micro_price as microPrice,
        mid_price as midPrice,
        micro_divergence as microDivergence,
        normalized_micro_divergence as normalizedMicroDivergence,
        spread_bps as spreadBps,
        depth_10bps as depth10bps,
        depth_25bps as depth25bps,
        depth_drop_rate as depthDropRate,
        liquidity_cliff as liquidityCliff,
        trade_intensity as tradeIntensity,
        signed_trade_imbalance as signedTradeImbalance,
        short_volatility_pct as shortVolatilityPct,
        liquidation_burst_intensity as liquidationBurstIntensity,
        liquidation_direction as liquidationDirection,
        liquidation_clustering as liquidationClustering,
        second_venue_return_5s as secondVenueReturn5s,
        second_venue_gap_bps as secondVenueGapBps
      FROM feature_snapshots_1s
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(symbol.toUpperCase()) as FeatureSnapshot1s | undefined;
    return row || null;
  }

  getLatestSnapshot1m(symbol: string): FeatureSnapshot1m | null {
    const row = this.db.prepare(`
      SELECT
        timestamp, symbol,
        top_imbalance_avg as topImbalanceAvg,
        multi_level_imbalance_avg as multiLevelImbalanceAvg,
        ofi_avg as ofiAvg,
        micro_divergence_avg as microDivergenceAvg,
        spread_bps_avg as spreadBpsAvg,
        depth_10bps_avg as depth10bpsAvg,
        trade_intensity_avg as tradeIntensityAvg,
        signed_trade_imbalance_avg as signedTradeImbalanceAvg,
        short_volatility_pct_avg as shortVolatilityPctAvg,
        top_imbalance_persistence_bull as topImbalancePersistenceBull,
        top_imbalance_persistence_bear as topImbalancePersistenceBear,
        micro_divergence_persistence_bull as microDivergencePersistenceBull,
        micro_divergence_persistence_bear as microDivergencePersistenceBear,
        imbalance_zscore as imbalanceZScore,
        ofi_zscore as ofiZScore,
        regime_label as regimeLabel
      FROM feature_snapshots_1m
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(symbol.toUpperCase()) as FeatureSnapshot1m | undefined;
    return row || null;
  }

  getStreamingHealth(): Array<{
    component: string;
    status: string;
    details: string;
    last_message_at: string;
    updated_at: string;
  }> {
    return this.db.prepare(`
      SELECT component, status, details, last_message_at, updated_at
      FROM streaming_health
      ORDER BY component ASC
    `).all() as Array<{
      component: string;
      status: string;
      details: string;
      last_message_at: string;
      updated_at: string;
    }>;
  }

  getFusionDecisions(limit = 100): Array<{
    timestamp: string;
    signal_id: string;
    asset_id: string;
    symbol: string;
    direction: string;
    p_hat: number;
    expectancy_hat_pct: number;
    hard_pass: number;
    soft_score: number;
    reasons_json: string;
    suppress_reasons_json: string;
    feature_flags_used_json: string;
    decision: string;
  }> {
    return this.db.prepare(`
      SELECT *
      FROM fusion_decisions
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as any[];
  }

  getSuppressedDecisions(limit = 100): Array<{
    timestamp: string;
    signal_id: string;
    asset_id: string;
    symbol: string;
    direction: string;
    p_hat: number;
    expectancy_hat_pct: number;
    suppress_reasons_json: string;
    reasons_json: string;
    feature_flags_used_json: string;
  }> {
    return this.db.prepare(`
      SELECT *
      FROM suppressed_decisions
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as any[];
  }

  getLatestLeaderLag(symbol: string): {
    timestamp: string;
    symbol: string;
    primary_return_5s: number;
    second_venue_return_5s: number;
    gap_bps: number;
  } | null {
    return (this.db.prepare(`
      SELECT timestamp, symbol, primary_return_5s, second_venue_return_5s, gap_bps
      FROM leader_lag_snapshots
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(symbol.toUpperCase()) as any) || null;
  }

  getTopCurrentConfirmationStates(limit = 20): Array<{
    symbol: string;
    top_imbalance: number;
    ofi_proxy: number;
    normalized_micro_divergence: number;
    spread_bps: number;
    depth_10bps: number;
    timestamp: string;
  }> {
    return this.db.prepare(`
      SELECT symbol, top_imbalance, ofi_proxy, normalized_micro_divergence, spread_bps, depth_10bps, timestamp
      FROM feature_snapshots_1s
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as any[];
  }
}
