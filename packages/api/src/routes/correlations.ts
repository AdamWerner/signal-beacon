import { Router } from 'express';
import { scanner } from '@polysignal/scanner';
import { AutoMapper } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

// Build asset ID → category map once at startup
const assetCategoryMap = new Map<string, string>(
  services.ontology.getAllAssets().map(a => [a.id, a.category])
);

// GET /api/correlations - Correlations grouped by ontology category
router.get('/', (req, res) => {
  try {
    const markets = services.marketStore.findAll(true);
    const autoMapper = new AutoMapper(services.ontology, services.instrumentRegistry);

    // Build per-asset stats
    const assetSignals = new Map<string, { count: number; avgConf: number; bestConf: number; bestSignalId: string | null }>();
    const recentSignals = services.signalStore.findFiltered({ hours: 48, limit: 500 });
    for (const sig of recentSignals) {
      const existing = assetSignals.get(sig.matched_asset_id) ?? { count: 0, avgConf: 0, bestConf: 0, bestSignalId: null };
      existing.count++;
      existing.avgConf = (existing.avgConf * (existing.count - 1) + sig.confidence) / existing.count;
      if (sig.confidence > existing.bestConf) {
        existing.bestConf = sig.confidence;
        existing.bestSignalId = sig.id;
      }
      assetSignals.set(sig.matched_asset_id, existing);
    }

    // Get latest snapshot per market for current odds
    const correlations = markets
      .map(market => {
        const mappings = autoMapper.mapMarketToInstruments(market);
        if (mappings.length === 0) return null;

        const latestSnapshot = services.snapshotStore.getHistory(market.condition_id, 1)[0];

        // Use ontology asset category for grouping (market.category is often null)
        const firstAssetCategory = assetCategoryMap.get(mappings[0]?.assetId) ?? market.category ?? 'other';

        return {
          market_condition_id: market.condition_id,
          market_title: market.title,
          market_slug: market.slug,
          category: firstAssetCategory,
          current_odds: latestSnapshot?.odds_yes ?? null,
          relevance_score: market.relevance_score,
          mappings: mappings.map(m => {
            const stats = assetSignals.get(m.assetId);
            return {
              asset_id: m.assetId,
              asset_name: m.assetName,
              polarity: m.polarity,
              explanation: m.explanation,
              bull_count: m.instruments.bull.length,
              bear_count: m.instruments.bear.length,
              signal_count_48h: stats?.count ?? 0,
              avg_confidence: stats ? Math.round(stats.avgConf) : 0,
              best_confidence: stats?.bestConf ?? 0,
              best_signal_id: stats?.bestSignalId ?? null
            };
          })
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    // Group by category
    const grouped: Record<string, typeof correlations> = {};
    for (const c of correlations) {
      const cat = c.category || 'other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(c);
    }

    // Sort each group by relevance_score desc, limit to 10 per category
    for (const cat of Object.keys(grouped)) {
      grouped[cat].sort((a, b) => b.relevance_score - a.relevance_score);
      grouped[cat] = grouped[cat].slice(0, 10);
    }

    res.json({
      categories: grouped,
      total_markets: correlations.length,
      total_with_signals: correlations.filter(c => c.mappings.some(m => m.signal_count_48h > 0)).length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch correlations' });
  }
});

export default router;
