import { Router } from 'express';
import { scanner } from '@polysignal/scanner';
import { wilsonInterval } from '../lib/wilson.js';

const router = Router();
const services = scanner.getServices();

type OutcomeRow = Record<string, any> & {
  signal_origin?: string | null;
  asset_id?: string | null;
  asset_name?: string | null;
  primary_source_family?: string | null;
  evaluated_at?: string | null;
  tp_first?: number | null;
  hit_sl?: number | null;
};

function buildHitRateSummary(rows: OutcomeRow[]) {
  const evaluated = rows.filter(row => Boolean(row.evaluated_at));
  const tpCount = evaluated.filter(row => Number(row.tp_first || 0) === 1).length;
  const lossCount = evaluated.filter(row => Number(row.hit_sl || 0) === 1 && Number(row.tp_first || 0) !== 1).length;
  const evalCount = evaluated.length;

  return {
    total: rows.length,
    evaluated: evalCount,
    wins: tpCount,
    losses: lossCount,
    hitRate: evalCount > 0 ? tpCount / evalCount : null,
    hitRateCI: wilsonInterval(tpCount, evalCount)
  };
}

router.get('/', (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, parseInt(String(req.query.days || '7'), 10) || 7));
    const db = (services as any).db;

    const outcomes = db.prepare(`
      SELECT
        po.*,
        COALESCE(s.matched_asset_name, po.asset_id) AS asset_name,
        COALESCE(s.primary_source_family, 'unknown') AS primary_source_family
      FROM push_outcomes po
      LEFT JOIN signals s
        ON s.id = po.signal_id
      WHERE push_timestamp >= datetime('now', '-' || ? || ' days')
      ORDER BY push_timestamp DESC
    `).all(days) as OutcomeRow[];

    const evaluated = outcomes.filter(row => Boolean(row.evaluated_at));
    const wins = evaluated.filter(row => Number(row.tp_first || 0) === 1);
    const losses = evaluated.filter(row => Number(row.hit_sl || 0) === 1 && Number(row.tp_first || 0) !== 1);
    const pending = outcomes.filter(row => !row.evaluated_at);

    const byOrigin: Record<string, ReturnType<typeof buildHitRateSummary> & { origin: string }> = {};
    for (const outcome of outcomes) {
      const origin = String(outcome.signal_origin || 'polymarket');
      if (!byOrigin[origin]) {
        byOrigin[origin] = { origin, ...buildHitRateSummary([]) };
      }
    }
    for (const origin of Object.keys(byOrigin)) {
      byOrigin[origin] = {
        origin,
        ...buildHitRateSummary(outcomes.filter(outcome => String(outcome.signal_origin || 'polymarket') === origin))
      };
    }

    const byAssetRows = new Map<string, OutcomeRow[]>();
    for (const outcome of outcomes) {
      const assetId = String(outcome.asset_id || 'unknown');
      if (!byAssetRows.has(assetId)) {
        byAssetRows.set(assetId, []);
      }
      byAssetRows.get(assetId)!.push(outcome);
    }
    const byAsset = Array.from(byAssetRows.entries()).map(([assetId, rows]) => ({
      assetId,
      assetName: String(rows[0]?.asset_name || assetId),
      ...buildHitRateSummary(rows)
    }));

    const bySourceFamilyRows = new Map<string, OutcomeRow[]>();
    for (const outcome of outcomes) {
      const family = String(outcome.primary_source_family || 'unknown');
      if (!bySourceFamilyRows.has(family)) {
        bySourceFamilyRows.set(family, []);
      }
      bySourceFamilyRows.get(family)!.push(outcome);
    }
    const bySourceFamily = Array.from(bySourceFamilyRows.entries()).map(([family, rows]) => ({
      sourceFamily: family,
      ...buildHitRateSummary(rows)
    }));

    const avgMaxFavorable = evaluated.length > 0
      ? evaluated.reduce((sum, row) => sum + Number(row.max_favorable_pct || 0), 0) / evaluated.length
      : null;

    const avgNetMaxFavorable = evaluated.length > 0
      ? evaluated.reduce((sum, row) => sum + Number(row.net_max_favorable_pct || 0), 0) / evaluated.length
      : null;

    const avgMaxAdverse = evaluated.length > 0
      ? evaluated.reduce((sum, row) => sum + Number(row.max_adverse_pct || 0), 0) / evaluated.length
      : null;

    const avgTimeToPeak = evaluated.length > 0
      ? evaluated.reduce((sum, row) => sum + Number(row.time_to_peak_minutes || 0), 0) / evaluated.length
      : null;

    res.json({
      total: outcomes.length,
      evaluated: evaluated.length,
      wins: wins.length,
      losses: losses.length,
      pending: pending.length,
      winRate: evaluated.length > 0 ? wins.length / evaluated.length : null,
      hitRateCI: wilsonInterval(wins.length, evaluated.length),
      avgMaxFavorable,
      avgNetMaxFavorable,
      avgMaxAdverse,
      avgTimeToPeak,
      byOrigin,
      byAsset,
      bySourceFamily,
      outcomes
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch push outcomes' });
  }
});

export default router;
