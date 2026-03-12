import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

// GET /api/backtest/runs?days=14
router.get('/runs', (req, res) => {
  try {
    const days = Math.max(1, Math.min(60, parseInt(req.query.days as string) || 14));
    const runs = (services as any).db.prepare(`
      SELECT *
      FROM daily_backtest_runs
      WHERE executed_at >= datetime('now', '-' || ? || ' days')
      ORDER BY executed_at DESC
    `).all(days);
    res.json(runs);
  } catch {
    res.status(500).json({ error: 'Failed to fetch backtest runs' });
  }
});

// GET /api/backtest/outcomes?market=swedish&hours=48&limit=200
router.get('/outcomes', (req, res) => {
  try {
    const market = req.query.market as 'swedish' | 'us' | undefined;
    const hours = Math.max(1, Math.min(24 * 30, parseInt(req.query.hours as string) || 72));
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit as string) || 200));

    const outcomes = market
      ? (services as any).db.prepare(`
          SELECT *
          FROM signal_outcomes
          WHERE market = ?
            AND evaluated_at >= datetime('now', '-' || ? || ' hours')
          ORDER BY evaluated_at DESC
          LIMIT ?
        `).all(market, hours, limit)
      : (services as any).db.prepare(`
          SELECT *
          FROM signal_outcomes
          WHERE evaluated_at >= datetime('now', '-' || ? || ' hours')
          ORDER BY evaluated_at DESC
          LIMIT ?
        `).all(hours, limit);

    res.json(outcomes);
  } catch {
    res.status(500).json({ error: 'Failed to fetch signal outcomes' });
  }
});

// GET /api/backtest/performance
router.get('/performance', (req, res) => {
  try {
    const scope = String(req.query.scope || 'all').toLowerCase();
    const table = scope === 'push' ? 'asset_push_performance' : 'asset_performance';
    const performance = (services as any).db.prepare(`
      SELECT *
      FROM ${table}
      ORDER BY reliability_score DESC, samples DESC
      LIMIT 200
    `).all();
    res.json(performance);
  } catch {
    res.status(500).json({ error: 'Failed to fetch asset performance' });
  }
});

// POST /api/backtest/run/:market
router.post('/run/:market', async (req, res) => {
  try {
    const market = req.params.market as 'swedish' | 'us';
    if (market !== 'swedish' && market !== 'us') {
      return res.status(400).json({ error: 'Market must be "swedish" or "us"' });
    }

    const result = await scanner.runDailyBacktest(market);
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ error: 'Backtest run failed', message: error?.message });
  }
});

// POST /api/backtest/run/:market/:date  (e.g. /run/us/2026-03-05)
// Always force-re-evaluates (ignores cached run for that date)
router.post('/run/:market/:date', async (req, res) => {
  try {
    const market = req.params.market as 'swedish' | 'us';
    if (market !== 'swedish' && market !== 'us') {
      return res.status(400).json({ error: 'Market must be "swedish" or "us"' });
    }

    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    }

    const result = await scanner.runDailyBacktest(market, date, true);
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ error: 'Backtest run failed', message: error?.message });
  }
});

// POST /api/backtest/catchup — evaluate last 7 days for both markets
router.post('/catchup', async (req, res) => {
  try {
    const results = [];
    for (let daysAgo = 1; daysAgo <= 7; daysAgo++) {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      const date = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
      for (const market of ['swedish', 'us'] as const) {
        const result = await scanner.runDailyBacktest(market, date, true);
        results.push(result);
      }
    }
    return res.json({ evaluated: results.length, results });
  } catch (error: any) {
    return res.status(500).json({ error: 'Catchup failed', message: error?.message });
  }
});

// GET /api/backtest/microstructure?days=14&market=us&latency=random
router.get('/microstructure', (req, res) => {
  try {
    const days = Math.max(1, Math.min(60, parseInt(String(req.query.days || '14'), 10)));
    const latencyMode = String(req.query.latency || 'random').toLowerCase() === 'worst_case'
      ? 'worst_case'
      : 'random';
    const marketParam = String(req.query.market || '').toLowerCase();
    const market = marketParam === 'swedish' || marketParam === 'us'
      ? (marketParam as 'swedish' | 'us')
      : undefined;

    const result = scanner.runMicrostructureBacktest({ days, market, latencyMode });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: 'Microstructure backtest failed', message: error?.message });
  }
});

// POST /api/backtest/microstructure/walk-forward?days=30
router.post('/microstructure/walk-forward', (req, res) => {
  try {
    const days = Math.max(7, Math.min(180, parseInt(String(req.query.days || req.body?.days || '30'), 10)));
    const result = scanner.runFusionWalkForward(days);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: 'Walk-forward tuning failed', message: error?.message });
  }
});

// GET /api/backtest/microstructure/weights/latest
router.get('/microstructure/weights/latest', (_req, res) => {
  try {
    res.json(scanner.getLatestFusionWeights());
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch latest fusion weights', message: error?.message });
  }
});

export default router;
