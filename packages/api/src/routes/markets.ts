import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

// GET /api/markets - Get all tracked markets
router.get('/', (req, res) => {
  try {
    const activeOnly = req.query.active !== 'false';
    const markets = services.marketStore.findAll(activeOnly);

    // Parse JSON fields
    const parsed = markets.map(market => ({
      ...market,
      matched_asset_ids: JSON.parse(market.matched_asset_ids)
    }));

    res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

// GET /api/markets/trending - Top 20 most volatile markets (must be before /:conditionId)
router.get('/trending', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;

    // Get recent signals to find volatile markets
    const recentSignals = services.signalStore.findFiltered({ hours: 24, limit: 500 });

    // Best (max abs delta) signal per market
    const bestByMarket = new Map<string, typeof recentSignals[0]>();
    for (const s of recentSignals) {
      const key = s.market_condition_id;
      const existing = bestByMarket.get(key);
      if (!existing || Math.abs(s.delta_pct) > Math.abs(existing.delta_pct)) {
        bestByMarket.set(key, s);
      }
    }

    // Sort by abs delta descending, take top N
    const topMarkets = Array.from(bestByMarket.values())
      .sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct))
      .slice(0, limit);

    // Enrich with current odds + sparkline + mapped assets
    const enriched = topMarkets.map(s => {
      const latest = services.snapshotStore.getLatest(s.market_condition_id);
      const sparkline = services.snapshotStore.getSparkline(s.market_condition_id, 4, 20);
      const market = services.marketStore.findByConditionId(s.market_condition_id);

      // 24h delta: compare latest vs snapshot from ~24h ago
      const snapshot24h = services.snapshotStore.getSnapshotAt(s.market_condition_id, 1440);
      const change_24h = latest && snapshot24h && snapshot24h.odds_yes > 0
        ? ((latest.odds_yes - snapshot24h.odds_yes) / snapshot24h.odds_yes) * 100
        : 0;

      // Mapped asset names from market record
      let mapped_assets: string[] = [];
      if (market?.matched_asset_ids) {
        try {
          const ids: string[] = JSON.parse(market.matched_asset_ids);
          mapped_assets = ids.map(id => services.ontology.getAsset?.(id)?.name ?? id).filter(Boolean);
        } catch { /* ignore */ }
      }

      return {
        condition_id: s.market_condition_id,
        title: s.market_title,
        slug: market?.slug ?? '',
        current_odds: latest?.odds_yes ?? s.odds_now,
        last_delta: s.delta_pct,
        change_24h: Math.round(change_24h * 10) / 10,
        whale_alert: false,
        sparkline,
        mapped_assets
      };
    });

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch trending markets' });
  }
});

// GET /api/markets/:conditionId - Get single market
router.get('/:conditionId', (req, res) => {
  try {
    const market = services.marketStore.findByConditionId(req.params.conditionId);

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    res.json({
      ...market,
      matched_asset_ids: JSON.parse(market.matched_asset_ids)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch market' });
  }
});

// GET /api/markets/:conditionId/odds - Get odds history
router.get('/:conditionId/odds', (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const history = services.snapshotStore.getHistory(req.params.conditionId, hours);

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch odds history' });
  }
});

// GET /api/markets/stats - Get market statistics
router.get('/stats', (req, res) => {
  try {
    const stats = services.marketStore.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
