import Database from 'better-sqlite3';
import { YahooPriceClient, PricePoint } from '../backtest/price-client.js';
import { getAssetTicker } from '../utils/ticker-map.js';

export interface PushOutcome {
  signalId: string;
  assetId: string;
  ticker: string;
  direction: 'bull' | 'bear';
  pushTimestamp: string;
  priceAtPush: number | null;
  priceAt10m: number | null;
  priceAt30m: number | null;
  priceAt60m: number | null;
  priceAt120m: number | null;
  hitTp: boolean;
  hitSl: boolean;
  tpFirst: boolean;
  maxFavorable: number;
  maxAdverse: number;
  timeToPeakMinutes: number;
  signalOrigin: string;
  confidence: number;
  sourceCount: number;
}

interface PendingPushSignal {
  id: string;
  matched_asset_id: string;
  suggested_action: string;
  push_sent_at: string;
  signal_origin: string | null;
  confidence: number;
  reasoning: string | null;
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
        s.reasoning
      FROM signals s
      LEFT JOIN push_outcomes po
        ON po.signal_id = s.id
      WHERE s.push_sent_at IS NOT NULL
        AND po.signal_id IS NULL
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
        source_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((rows: PendingPushSignal[]) => {
      for (const row of rows) {
        const direction = this.getDirection(row.suggested_action);
        const ticker = getAssetTicker(row.matched_asset_id);
        insert.run(
          row.id,
          row.matched_asset_id,
          ticker,
          direction,
          row.push_sent_at,
          row.signal_origin || 'polymarket',
          row.confidence || 0,
          this.extractSourceCount(row.reasoning || '', row.signal_origin || 'polymarket')
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
        po.signal_origin,
        po.confidence,
        po.source_count
      FROM push_outcomes po
      WHERE po.evaluated_at IS NULL
        AND po.push_timestamp <= datetime('now', '-120 minutes')
      ORDER BY po.push_timestamp DESC
      LIMIT ?
    `).all(limit) as Array<{
      signal_id: string;
      asset_id: string;
      ticker: string | null;
      direction: 'bull' | 'bear';
      push_timestamp: string;
      signal_origin: string | null;
      confidence: number | null;
      source_count: number | null;
    }>;

    let evaluated = 0;

    for (const candidate of candidates) {
      const outcome = await this.evaluateSingle(candidate);
      if (!outcome) continue;
      this.persistEvaluatedOutcome(outcome);
      evaluated += 1;
    }

    return { created, evaluated };
  }

  private async evaluateSingle(candidate: {
    signal_id: string;
    asset_id: string;
    ticker: string | null;
    direction: 'bull' | 'bear';
    push_timestamp: string;
    signal_origin: string | null;
    confidence: number | null;
    source_count: number | null;
  }): Promise<PushOutcome | null> {
    const ticker = candidate.ticker || getAssetTicker(candidate.asset_id);
    if (!ticker) return null;

    const pushMs = new Date(candidate.push_timestamp.replace(' ', 'T') + 'Z').getTime();
    if (!Number.isFinite(pushMs)) return null;

    const endMs = pushMs + (120 * 60 * 1000);
    const points = await this.priceClient.getSeries(ticker, pushMs, endMs);
    if (points.length < 3) return null;

    const entryPoint = pickPoint(points, pushMs);
    if (!entryPoint || entryPoint.close <= 0) return null;

    const direction = candidate.direction;
    const directionalPoints = points
      .filter(point => point.timestampMs >= pushMs && point.close > 0)
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
        timeToPeakMinutes = (point.timestampMs - pushMs) / 60000;
      }
      if (point.movePct < maxAdverse) {
        maxAdverse = point.movePct;
      }
      if (firstTpMs == null && point.movePct >= 3) {
        hitTp = true;
        firstTpMs = point.timestampMs;
      }
      if (firstSlMs == null && point.movePct <= -2) {
        hitSl = true;
        firstSlMs = point.timestampMs;
      }
    }

    if (firstTpMs != null && (firstSlMs == null || firstTpMs <= firstSlMs)) {
      tpFirst = true;
    }

    return {
      signalId: candidate.signal_id,
      assetId: candidate.asset_id,
      ticker,
      direction,
      pushTimestamp: new Date(pushMs).toISOString(),
      priceAtPush: entryPoint.close,
      priceAt10m: this.getPriceAt(points, pushMs, 10),
      priceAt30m: this.getPriceAt(points, pushMs, 30),
      priceAt60m: this.getPriceAt(points, pushMs, 60),
      priceAt120m: this.getPriceAt(points, pushMs, 120),
      hitTp,
      hitSl,
      tpFirst,
      maxFavorable: Number.isFinite(maxFavorable) ? maxFavorable : 0,
      maxAdverse: Number.isFinite(maxAdverse) ? maxAdverse : 0,
      timeToPeakMinutes,
      signalOrigin: candidate.signal_origin || 'polymarket',
      confidence: candidate.confidence || 0,
      sourceCount: candidate.source_count || 1
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
          price_at_push = ?,
          price_at_10m = ?,
          price_at_30m = ?,
          price_at_60m = ?,
          price_at_120m = ?,
          hit_tp = ?,
          hit_sl = ?,
          tp_first = ?,
          max_favorable_pct = ?,
          max_adverse_pct = ?,
          time_to_peak_minutes = ?,
          evaluated_at = datetime('now')
      WHERE signal_id = ?
    `).run(
      outcome.ticker,
      outcome.direction,
      outcome.signalOrigin,
      outcome.confidence,
      outcome.sourceCount,
      outcome.priceAtPush,
      outcome.priceAt10m,
      outcome.priceAt30m,
      outcome.priceAt60m,
      outcome.priceAt120m,
      outcome.hitTp ? 1 : 0,
      outcome.hitSl ? 1 : 0,
      outcome.tpFirst ? 1 : 0,
      outcome.maxFavorable,
      outcome.maxAdverse,
      outcome.timeToPeakMinutes,
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

  private extractSourceCount(reasoning: string, signalOrigin: string): number {
    const catalystMatch = reasoning.match(/\[catalysts:(\d+)\]/i);
    if (catalystMatch) {
      const parsed = parseInt(catalystMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    if (signalOrigin === 'hybrid') {
      return 2;
    }

    return signalOrigin === 'catalyst_convergence' ? 2 : 1;
  }
}
