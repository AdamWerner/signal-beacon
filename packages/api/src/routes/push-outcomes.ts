import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

router.get('/', (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, parseInt(String(req.query.days || '7'), 10) || 7));
    const db = (services as any).db;

    const outcomes = db.prepare(`
      SELECT *
      FROM push_outcomes
      WHERE push_timestamp >= datetime('now', '-' || ? || ' days')
      ORDER BY push_timestamp DESC
    `).all(days) as Array<Record<string, any>>;

    const evaluated = outcomes.filter(row => Boolean(row.evaluated_at));
    const wins = evaluated.filter(row => Number(row.tp_first || 0) === 1);
    const losses = evaluated.filter(row => Number(row.hit_sl || 0) === 1 && Number(row.tp_first || 0) !== 1);
    const pending = outcomes.filter(row => !row.evaluated_at);

    const byOrigin: Record<string, { total: number; evaluated: number; wins: number; losses: number; winRate: number | null }> = {};
    for (const outcome of outcomes) {
      const origin = String(outcome.signal_origin || 'polymarket');
      if (!byOrigin[origin]) {
        byOrigin[origin] = {
          total: 0,
          evaluated: 0,
          wins: 0,
          losses: 0,
          winRate: null
        };
      }

      byOrigin[origin].total += 1;
      if (outcome.evaluated_at) {
        byOrigin[origin].evaluated += 1;
        if (Number(outcome.tp_first || 0) === 1) {
          byOrigin[origin].wins += 1;
        } else if (Number(outcome.hit_sl || 0) === 1) {
          byOrigin[origin].losses += 1;
        }
      }
    }

    for (const origin of Object.keys(byOrigin)) {
      const row = byOrigin[origin];
      row.winRate = row.evaluated > 0 ? row.wins / row.evaluated : null;
    }

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
      avgMaxFavorable,
      avgNetMaxFavorable,
      avgMaxAdverse,
      avgTimeToPeak,
      byOrigin,
      outcomes
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch push outcomes' });
  }
});

export default router;
