import { Router } from 'express';
import { scanner } from '@polysignal/scanner';
import { AutoMapper } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

// GET /api/correlations - Get all auto-mapped correlations
router.get('/', (req, res) => {
  try {
    const markets = services.marketStore.findAll(true);
    const autoMapper = new AutoMapper(services.ontology, services.instrumentRegistry);

    const correlations = markets
      .map(market => {
        const mappings = autoMapper.mapMarketToInstruments(market);
        return {
          market_condition_id: market.condition_id,
          market_title: market.title,
          market_slug: market.slug,
          mappings: mappings.map(m => ({
            asset_id: m.assetId,
            asset_name: m.assetName,
            polarity: m.polarity,
            explanation: m.explanation,
            bull_count: m.instruments.bull.length,
            bear_count: m.instruments.bear.length
          }))
        };
      })
      .filter(c => c.mappings.length > 0); // only markets that matched ontology

    res.json(correlations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch correlations' });
  }
});

export default router;
