import Database from 'better-sqlite3';
import { YahooPriceClient, PricePoint } from '../backtest/price-client.js';
import { estimateExecutionCost } from './execution-feasibility.js';
import { getAssetTicker } from '../utils/ticker-map.js';
import { getAssetMarket, getNextMarketOpenAt, isMarketOpenAt } from './trading-hours.js';

const TP_THRESHOLD_PCT = parseFloat(process.env.PUSH_TP_UNDERLYING_PCT || '1.5');
const SL_THRESHOLD_PCT = parseFloat(process.env.PUSH_SL_UNDERLYING_PCT || '1.0');

export interface PushOutcome {
  signalId: string;
  assetId: string;
  ticker: string;
  direction: 'bull' | 'bear';
  pushTimestamp: string;
  entryAnchor: 'immediate' | 'next_open';
  entryAnchorTs: string;
  priceAtPush: number | null;
  priceAt10m: number | null;
  priceAt30m: number | null;
  priceAt60m: number | null;
  priceAt120m: number | null;
  priceAt180m: number | null;
  priceAt240m: number | null;
  hitTp: boolean;
  hitSl: boolean;
  tpFirst: boolean;
  maxFavorable: number;
  netMaxFavorable: number;
  maxAdverse: number;
  timeToPeakMinutes: number;
  directionallyAccurate: boolean;
  signalOrigin: string;
  confidence: number;
  sourceCount: number;
  estimatedRoundTripCostPct: number;
  evaluationNotes: string | null;
}

interface PendingPushSignal {
  id: string;
  matched_asset_id: string;
  suggested_action: string;
  push_sent_at: string;
  signal_origin: string | null;
  confidence: number;
  reasoning: string | null;
  source_count_override: number | null;
}

interface PendingOutcomeCandidate {
  signal_id: string;
  asset_id: string;
  ticker: string | null;
  direction: 'bull' | 'bear';
  push_timestamp: string;
  shadow_push_at: string | null;
  signal_origin: string | null;
  confidence: number | null;
  source_count: number | null;
  estimated_round_trip_cost_pct: number | null;
  is_shadow: number | null;
}

export function calculateNetMaxFavorable(maxFavorablePct: number, roundTripCostPct: number | null | undefined): number {
  const costPct = roundTripCostPct ?? 0;
  return maxFavorablePct - (costPct * 100);
}

function directionalMovePct(entry: number, price: number, direction: 'bull' | 'bear'): number {
  const raw = ((price - entry) / entry) * 100;
  return direction === 'bull' ? raw : -raw;
}

function pickPoint(points: PricePoint[], targetMs: number): PricePoint | null {
  if (points.length === 0) return null;
  for (const point of points) {
    if (point.timestampMs >= targetMs) {
      return point;
    }
  }
  return points[points.length - 1] || null;
}

function parseStoredTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function resolveEntryAnchor(
  assetId: string,
  pushTimestamp: string
): { entryAnchor: 'immediate' | 'next_open'; entryAnchorTs: string } | null {
  const pushDate = parseStoredTimestamp(pushTimestamp);
  if (!pushDate) return null;

  const market = getAssetMarket(assetId);
  if (isMarketOpenAt(market, pushDate)) {
    return {
      entryAnchor: 'immediate',
      entryAnchorTs: pushDate.toISOString()
    };
  }

  const nextOpen = getNextMarketOpenAt(market, pushDate);
  return {
    entryAnchor: 'next_open',
    entryAnchorTs: nextOpen.toISOString()
  };
}

export class PushOutcomeTracker {
  private priceClient = new YahooPriceClient();

  constructor(private db: Database.Database) {}

  ensurePendingOutcomeRows(): number {
    const pendingSignals = this.db.prepare(`
      SELECT
        s.id,
        s.matched_asset_id,
        s.suggested_action,
        s.push_sent_at,
        COALESCE(s.signal_origin, 'polymarket') AS signal_origin,
        s.confidence,
        s.reasoning,
        s.source_count_override
      FROM signals s
      LEFT JOIN push_outcomes po
        ON po.signal_id = s.id
      WHERE s.push_sent_at IS NOT NULL
        AND po.signal_id IS NULL
        AND COALESCE(s.signal_origin, 'polymarket') <> 'canary'
        AND COALESCE(s.status, 'active') <> 'dismissed'
      ORDER BY s.push_sent_at DESC
      LIMIT 200
    `).all() as PendingPushSignal[];

    if (pendingSignals.length === 0) {
      return 0;
    }

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO push_outcomes (
        signal_id,
        asset_id,
        ticker,
        direction,
        push_timestamp,
        signal_origin,
        confidence,
        source_count,
        estimated_round_trip_cost_pct
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((rows: PendingPushSignal[]) => {
      for (const row of rows) {
        const direction = this.getDirection(row.suggested_action);
        const ticker = getAssetTicker(row.matched_asset_id);
        const executionCost = estimateExecutionCost(row.matched_asset_id, 3);
        insert.run(
          row.id,
          row.matched_asset_id,
          ticker,
          direction,
          row.push_sent_at,
          row.signal_origin || 'polymarket',
          row.confidence || 0,
          this.extractSourceCount(row.source_count_override, row.signal_origin || 'polymarket'),
          executionCost.roundTripCostPct
        );
      }
    });

    tx(pendingSignals);
    return pendingSignals.length;
  }

  async evaluatePendingOutcomes(limit = 25): Promise<{ created: number; evaluated: number }> {
    const created = this.ensurePendingOutcomeRows();
    const candidates = this.db.prepare(`
      SELECT
        po.signal_id,
        po.asset_id,
        po.ticker,
        po.direction,
        po.push_timestamp,
        po.shadow_push_at,
        po.signal_origin,
        po.confidence,
        po.source_count,
        po.estimated_round_trip_cost_pct,
        COALESCE(po.is_shadow, 0) AS is_shadow
      FROM push_outcomes po
      LEFT JOIN signals s
        ON s.id = po.signal_id
      WHERE po.evaluated_at IS NULL
        AND COALESCE(po.signal_origin, 'polymarket') <> 'canary'
        AND COALESCE(s.signal_origin, 'polymarket') <> 'canary'
        AND COALESCE(s.status, 'active') <> 'dismissed'
      ORDER BY COALESCE(po.shadow_push_at, po.push_timestamp) DESC
      LIMIT ?
    `).all(limit) as PendingOutcomeCandidate[];

    let evaluated = 0;
    const readyCandidates = candidates.filter(candidate => this.isCandidateReady(candidate));

    for (const candidate of readyCandidates) {
      const outcome = await this.evaluateSingle(candidate);
      if (!outcome) continue;
      this.persistEvaluatedOutcome(outcome);
      evaluated += 1;
    }

    return { created, evaluated };
  }

  private async evaluateSingle(candidate: PendingOutcomeCandidate): Promise<PushOutcome | null> {
    const ticker = candidate.ticker || getAssetTicker(candidate.asset_id);
    if (!ticker) return null;

    const pushedAt = candidate.is_shadow ? (candidate.shadow_push_at || candidate.push_timestamp) : candidate.push_timestamp;
    const anchor = resolveEntryAnchor(candidate.asset_id, pushedAt);
    if (!anchor) return null;

    const pushDate = parseStoredTimestamp(candidate.push_timestamp);
    const anchorDate = parseStoredTimestamp(anchor.entryAnchorTs);
    if (!pushDate || !anchorDate) return null;
    const pushMs = pushDate.getTime();
    const anchorMs = anchorDate.getTime();

    const endMs = anchorMs + (240 * 60 * 1000);
    const points = await this.priceClient.getSeries(ticker, anchorMs, endMs);
    if (points.length < 3) {
      return this.buildNoBarsOutcome(candidate, ticker, pushMs, anchor);
    }

    const entryPoint = pickPoint(points, anchorMs);
    if (!entryPoint || entryPoint.close <= 0) {
      return this.buildNoBarsOutcome(candidate, ticker, pushMs, anchor);
    }

    const direction = candidate.direction;
    const directionalPoints = points
      .filter(point => point.timestampMs >= anchorMs && point.close > 0)
      .map(point => ({
        ...point,
        movePct: directionalMovePct(entryPoint.close, point.close, direction)
      }));

    if (directionalPoints.length === 0) return null;

    let hitTp = false;
    let hitSl = false;
    let tpFirst = false;
    let firstTpMs: number | null = null;
    let firstSlMs: number | null = null;
    let maxFavorable = Number.NEGATIVE_INFINITY;
    let maxAdverse = Number.POSITIVE_INFINITY;
    let timeToPeakMinutes = 0;

    for (const point of directionalPoints) {
      if (point.movePct > maxFavorable) {
        maxFavorable = point.movePct;
        timeToPeakMinutes = (point.timestampMs - anchorMs) / 60000;
      }
      if (point.movePct < maxAdverse) {
        maxAdverse = point.movePct;
      }
      if (firstTpMs == null && point.movePct >= TP_THRESHOLD_PCT) {
        hitTp = true;
        firstTpMs = point.timestampMs;
      }
      if (firstSlMs == null && point.movePct <= -SL_THRESHOLD_PCT) {
        hitSl = true;
        firstSlMs = point.timestampMs;
      }
    }

    if (firstTpMs != null && (firstSlMs == null || firstTpMs <= firstSlMs)) {
      tpFirst = true;
    }

    // Directional accuracy: price moved in the right direction within 60 minutes
    const price60m = this.getPriceAt(points, anchorMs, 60);
    const directionallyAccurate = price60m !== null && entryPoint.close > 0
      ? direction === 'bull'
        ? price60m > entryPoint.close
        : price60m < entryPoint.close
      : false;
    const estimatedRoundTripCostPct = candidate.estimated_round_trip_cost_pct ?? estimateExecutionCost(candidate.asset_id, 3).roundTripCostPct;
    const resolvedMaxFavorable = Number.isFinite(maxFavorable) ? maxFavorable : 0;

    return {
      signalId: candidate.signal_id,
      assetId: candidate.asset_id,
      ticker,
      direction,
      pushTimestamp: new Date(pushMs).toISOString(),
      entryAnchor: anchor.entryAnchor,
      entryAnchorTs: anchor.entryAnchorTs,
      priceAtPush: entryPoint.close,
      priceAt10m: this.getPriceAt(points, anchorMs, 10),
      priceAt30m: this.getPriceAt(points, anchorMs, 30),
      priceAt60m: price60m,
      priceAt120m: this.getPriceAt(points, anchorMs, 120),
      priceAt180m: this.getPriceAt(points, anchorMs, 180),
      priceAt240m: this.getPriceAt(points, anchorMs, 240),
      hitTp,
      hitSl,
      tpFirst,
      maxFavorable: resolvedMaxFavorable,
      netMaxFavorable: calculateNetMaxFavorable(resolvedMaxFavorable, estimatedRoundTripCostPct),
      maxAdverse: Number.isFinite(maxAdverse) ? maxAdverse : 0,
      timeToPeakMinutes,
      directionallyAccurate,
      signalOrigin: candidate.signal_origin || 'polymarket',
      confidence: candidate.confidence || 0,
      sourceCount: candidate.source_count || 1,
      estimatedRoundTripCostPct,
      evaluationNotes: null
    };
  }

  private buildNoBarsOutcome(
    candidate: PendingOutcomeCandidate,
    ticker: string,
    pushMs: number,
    anchor: { entryAnchor: 'immediate' | 'next_open'; entryAnchorTs: string }
  ): PushOutcome {
    const estimatedRoundTripCostPct =
      candidate.estimated_round_trip_cost_pct ?? estimateExecutionCost(candidate.asset_id, 3).roundTripCostPct;
    return {
      signalId: candidate.signal_id,
      assetId: candidate.asset_id,
      ticker,
      direction: candidate.direction,
      pushTimestamp: new Date(pushMs).toISOString(),
      entryAnchor: anchor.entryAnchor,
      entryAnchorTs: anchor.entryAnchorTs,
      priceAtPush: null,
      priceAt10m: null,
      priceAt30m: null,
      priceAt60m: null,
      priceAt120m: null,
      priceAt180m: null,
      priceAt240m: null,
      hitTp: false,
      hitSl: false,
      tpFirst: false,
      maxFavorable: 0,
      netMaxFavorable: 0,
      maxAdverse: 0,
      timeToPeakMinutes: 0,
      directionallyAccurate: false,
      signalOrigin: candidate.signal_origin || 'polymarket',
      confidence: candidate.confidence || 0,
      sourceCount: candidate.source_count || 1,
      estimatedRoundTripCostPct,
      evaluationNotes: 'no_bars'
    };
  }

  private persistEvaluatedOutcome(outcome: PushOutcome): void {
    this.db.prepare(`
      UPDATE push_outcomes
      SET ticker = ?,
          direction = ?,
          signal_origin = ?,
          confidence = ?,
          source_count = ?,
          entry_anchor = ?,
          entry_anchor_ts = ?,
          price_at_push = ?,
          price_at_10m = ?,
          price_at_30m = ?,
          price_at_60m = ?,
          price_at_120m = ?,
          price_at_180m = ?,
          price_at_240m = ?,
          hit_tp = ?,
          hit_sl = ?,
          tp_first = ?,
          max_favorable_pct = ?,
          net_max_favorable_pct = ?,
          max_adverse_pct = ?,
          time_to_peak_minutes = ?,
          directionally_accurate = ?,
          estimated_round_trip_cost_pct = ?,
          evaluation_notes = ?,
          evaluated_at = datetime('now')
      WHERE signal_id = ?
    `).run(
      outcome.ticker,
      outcome.direction,
      outcome.signalOrigin,
      outcome.confidence,
      outcome.sourceCount,
      outcome.entryAnchor,
      outcome.entryAnchorTs.replace('T', ' ').replace('Z', ''),
      outcome.priceAtPush,
      outcome.priceAt10m,
      outcome.priceAt30m,
      outcome.priceAt60m,
      outcome.priceAt120m,
      outcome.priceAt180m,
      outcome.priceAt240m,
      outcome.hitTp ? 1 : 0,
      outcome.hitSl ? 1 : 0,
      outcome.tpFirst ? 1 : 0,
      outcome.maxFavorable,
      outcome.netMaxFavorable,
      outcome.maxAdverse,
      outcome.timeToPeakMinutes,
      outcome.directionallyAccurate ? 1 : 0,
      outcome.estimatedRoundTripCostPct,
      outcome.evaluationNotes,
      outcome.signalId
    );
  }

  private getPriceAt(points: PricePoint[], pushMs: number, minutes: number): number | null {
    const point = pickPoint(points, pushMs + (minutes * 60 * 1000));
    return point?.close ?? null;
  }

  private getDirection(action: string): 'bull' | 'bear' {
    return action.toLowerCase().includes('bull') ? 'bull' : 'bear';
  }

  private extractSourceCount(sourceCountOverride: number | null | undefined, signalOrigin: string): number {
    if (sourceCountOverride != null && sourceCountOverride > 0) {
      return sourceCountOverride;
    }
    if (signalOrigin === 'hybrid') return 2;
    return signalOrigin === 'catalyst_convergence' ? 2 : 1;
  }

  private isCandidateReady(candidate: PendingOutcomeCandidate): boolean {
    const pushedAt = candidate.is_shadow ? (candidate.shadow_push_at || candidate.push_timestamp) : candidate.push_timestamp;
    const anchor = resolveEntryAnchor(candidate.asset_id, pushedAt);
    if (!anchor) return false;
    const anchorDate = parseStoredTimestamp(anchor.entryAnchorTs);
    if (!anchorDate) return false;
    return anchorDate.getTime() + (240 * 60 * 1000) <= Date.now();
  }
}
