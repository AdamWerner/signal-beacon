import Database from 'better-sqlite3';

type LatencyMode = 'worst_case' | 'random';

interface OutcomeRow {
  signal_id: string;
  asset_id: string;
  asset_name: string;
  move_60m_pct: number | null;
  favorable_peak_60m_pct: number | null;
  adverse_peak_60m_pct: number | null;
  direction_correct_60m: number | null;
  market: 'swedish' | 'us';
  entry_time: string;
  reasoning: string;
}

interface BarrierResult {
  outcome: 'win' | 'loss' | 'timeout';
  pnlPct: number;
  holdMinutes: number;
}

export function simulateBarrierOutcome(
  row: {
    favorable_peak_60m_pct: number | null;
    adverse_peak_60m_pct: number | null;
    move_60m_pct: number | null;
  },
  latencyMode: LatencyMode
): BarrierResult {
  const favorable = row.favorable_peak_60m_pct ?? 0;
  const adverse = row.adverse_peak_60m_pct ?? 0;
  const tp = 3;
  const sl = -2;

  const touchedTp = favorable >= tp;
  const touchedSl = adverse <= sl;
  const latencyMinutes = latencyMode === 'worst_case'
    ? 5
    : 1 + Math.floor(Math.random() * 5);

  if (touchedTp && !touchedSl) return { outcome: 'win', pnlPct: tp, holdMinutes: 10 + latencyMinutes };
  if (!touchedTp && touchedSl) return { outcome: 'loss', pnlPct: sl, holdMinutes: 10 + latencyMinutes };
  if (touchedTp && touchedSl) {
    if (latencyMode === 'worst_case') {
      return { outcome: 'loss', pnlPct: sl, holdMinutes: 12 + latencyMinutes };
    }
    return Math.random() > 0.5
      ? { outcome: 'win', pnlPct: tp, holdMinutes: 12 + latencyMinutes }
      : { outcome: 'loss', pnlPct: sl, holdMinutes: 12 + latencyMinutes };
  }

  const fallbackMove = row.move_60m_pct ?? 0;
  if (fallbackMove >= 0.5) return { outcome: 'win', pnlPct: Math.min(tp, fallbackMove), holdMinutes: 60 };
  if (fallbackMove <= -0.5) return { outcome: 'loss', pnlPct: Math.max(sl, fallbackMove), holdMinutes: 60 };
  return { outcome: 'timeout', pnlPct: fallbackMove, holdMinutes: 60 };
}

export class MicrostructureBacktestRunner {
  constructor(private db: Database.Database) {}

  runComparison(options?: {
    days?: number;
    market?: 'swedish' | 'us';
    latencyMode?: LatencyMode;
  }) {
    const days = Math.max(1, Math.min(60, options?.days ?? 14));
    const latencyMode: LatencyMode = options?.latencyMode ?? 'random';
    const market = options?.market;

    const rows = this.fetchRows(days, market);
    const allowIds = new Set<string>(this.db.prepare(`
      SELECT DISTINCT signal_id
      FROM fusion_decisions
      WHERE decision = 'allow'
        AND timestamp >= datetime('now', '-' || ? || ' days')
    `).all(days).map((row: any) => String(row.signal_id)));

    const baseline = this.evaluate(rows, latencyMode);
    const fusionRows = rows.filter(row => allowIds.has(row.signal_id));
    const fusion = this.evaluate(fusionRows, latencyMode);

    const withOfi = this.evaluate(
      fusionRows.filter(row => row.reasoning.toLowerCase().includes('ofi')),
      latencyMode
    );
    const withMicro = this.evaluate(
      fusionRows.filter(row => row.reasoning.toLowerCase().includes('micro')),
      latencyMode
    );
    const withoutLiquidityStress = this.evaluate(
      fusionRows.filter(row => !row.reasoning.toLowerCase().includes('liquidity stress')),
      latencyMode
    );

    const suppressedCount = (this.db.prepare(`
      SELECT COUNT(*) as c
      FROM suppressed_decisions
      WHERE timestamp >= datetime('now', '-' || ? || ' days')
    `).get(days) as { c: number }).c;

    const allowedCount = (this.db.prepare(`
      SELECT COUNT(*) as c
      FROM fusion_decisions
      WHERE decision = 'allow'
        AND timestamp >= datetime('now', '-' || ? || ' days')
    `).get(days) as { c: number }).c;

    const bySymbol = this.groupBySymbol(fusionRows, latencyMode);
    const byVolRegime = this.groupByRegime(fusionRows, latencyMode, 'vol');
    const byLiquidityRegime = this.groupByRegime(fusionRows, latencyMode, 'liquidity');

    return {
      days,
      market: market || 'all',
      latencyMode,
      baseline,
      fusion,
      ablations: {
        withOfi,
        withMicro,
        withoutLiquidityStress
      },
      suppressedVsAllowed: {
        suppressed: suppressedCount,
        allowed: allowedCount
      },
      bySymbol,
      byVolRegime,
      byLiquidityRegime
    };
  }

  runWalkForwardScaffold(days = 30) {
    const rows = this.fetchRows(days);
    if (rows.length < 20) {
      return {
        tuned: false,
        reason: 'insufficient samples',
        samples: rows.length
      };
    }

    const withOfi = rows.filter(row => row.reasoning.toLowerCase().includes('ofi'));
    const withMicro = rows.filter(row => row.reasoning.toLowerCase().includes('micro'));
    const ofiWinRate = this.evaluate(withOfi, 'random').winRate;
    const microWinRate = this.evaluate(withMicro, 'random').winRate;

    const tunedWeights = {
      ofi: ofiWinRate >= 0.52 ? 0.14 : 0.08,
      microDivergence: microWinRate >= 0.52 ? 0.13 : 0.08,
      liquidityCliffPenalty: microWinRate < 0.5 ? 0.14 : 0.1
    };

    this.db.prepare(`
      UPDATE fusion_weight_sets
      SET is_active = FALSE
      WHERE is_active = TRUE
    `).run();

    this.db.prepare(`
      INSERT INTO fusion_weight_sets (label, weights_json, metrics_json, is_active)
      VALUES (?, ?, ?, TRUE)
    `).run(
      `walk_forward_${new Date().toISOString().slice(0, 10)}`,
      JSON.stringify(tunedWeights),
      JSON.stringify({
        ofiWinRate,
        microWinRate,
        samples: rows.length
      })
    );

    return {
      tuned: true,
      samples: rows.length,
      weights: tunedWeights,
      metrics: {
        ofiWinRate,
        microWinRate
      }
    };
  }

  getLatestTunedWeights() {
    const row = this.db.prepare(`
      SELECT id, label, weights_json, metrics_json, created_at, is_active
      FROM fusion_weight_sets
      ORDER BY created_at DESC
      LIMIT 1
    `).get() as any;
    if (!row) return null;
    return {
      ...row,
      weights: this.safeJson(row.weights_json),
      metrics: this.safeJson(row.metrics_json)
    };
  }

  private fetchRows(days: number, market?: 'swedish' | 'us'): OutcomeRow[] {
    if (market) {
      return this.db.prepare(`
        SELECT
          so.signal_id,
          so.asset_id,
          so.asset_name,
          so.move_60m_pct,
          so.favorable_peak_60m_pct,
          so.adverse_peak_60m_pct,
          so.direction_correct_60m,
          so.market,
          so.entry_time,
          COALESCE(s.reasoning, '') as reasoning
        FROM signal_outcomes so
        JOIN signals s ON s.id = so.signal_id
        WHERE so.market = ?
          AND so.evaluated_at >= datetime('now', '-' || ? || ' days')
      `).all(market, days) as OutcomeRow[];
    }

    return this.db.prepare(`
      SELECT
        so.signal_id,
        so.asset_id,
        so.asset_name,
        so.move_60m_pct,
        so.favorable_peak_60m_pct,
        so.adverse_peak_60m_pct,
        so.direction_correct_60m,
        so.market,
        so.entry_time,
        COALESCE(s.reasoning, '') as reasoning
      FROM signal_outcomes so
      JOIN signals s ON s.id = so.signal_id
      WHERE so.evaluated_at >= datetime('now', '-' || ? || ' days')
    `).all(days) as OutcomeRow[];
  }

  private evaluate(rows: OutcomeRow[], latencyMode: LatencyMode) {
    if (rows.length === 0) {
      return {
        trades: 0,
        winRate: 0,
        expectancy: 0,
        avgHoldMinutes: 0,
        drawdownProxy: 0,
        hitDistribution: { win: 0, loss: 0, timeout: 0 }
      };
    }

    const results = rows.map(row => this.simulateBarrier(row, latencyMode));
    const wins = results.filter(result => result.outcome === 'win').length;
    const losses = results.filter(result => result.outcome === 'loss').length;
    const timeout = results.filter(result => result.outcome === 'timeout').length;
    const expectancy = results.reduce((sum, result) => sum + result.pnlPct, 0) / results.length;
    const avgHold = results.reduce((sum, result) => sum + result.holdMinutes, 0) / results.length;
    const drawdownProxy = Math.abs(Math.min(0, ...results.map(result => result.pnlPct)));

    return {
      trades: rows.length,
      winRate: wins / rows.length,
      expectancy,
      avgHoldMinutes: avgHold,
      drawdownProxy,
      hitDistribution: { win: wins, loss: losses, timeout }
    };
  }

  private simulateBarrier(row: OutcomeRow, latencyMode: LatencyMode): BarrierResult {
    return simulateBarrierOutcome(row, latencyMode);
  }

  private groupBySymbol(rows: OutcomeRow[], latencyMode: LatencyMode) {
    const groups = new Map<string, OutcomeRow[]>();
    for (const row of rows) {
      const bucket = groups.get(row.asset_id) || [];
      bucket.push(row);
      groups.set(row.asset_id, bucket);
    }
    return Array.from(groups.entries()).map(([assetId, groupRows]) => ({
      assetId,
      ...this.evaluate(groupRows, latencyMode)
    }));
  }

  private groupByRegime(rows: OutcomeRow[], latencyMode: LatencyMode, mode: 'vol' | 'liquidity') {
    const buckets: Record<string, OutcomeRow[]> = {};
    for (const row of rows) {
      const reasoning = (row.reasoning || '').toLowerCase();
      let key = 'unknown';
      if (mode === 'vol') {
        if (reasoning.includes('[vol:high')) key = 'high';
        else if (reasoning.includes('[vol:low')) key = 'low';
        else if (reasoning.includes('[vol:normal')) key = 'normal';
        else if (reasoning.includes('[vol:extreme')) key = 'extreme';
      } else {
        key = reasoning.includes('liquidity stress') ? 'stress' : 'normal';
      }
      buckets[key] = buckets[key] || [];
      buckets[key].push(row);
    }

    return Object.entries(buckets).map(([regime, regimeRows]) => ({
      regime,
      ...this.evaluate(regimeRows, latencyMode)
    }));
  }

  private safeJson(value: string | null | undefined) {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
}
