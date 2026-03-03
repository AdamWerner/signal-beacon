import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

// GET /api/ontology - Get current ontology
router.get('/', (req, res) => {
  try {
    const assets = services.ontology.getAllAssets();

    // Add market counts for each asset
    const marketCounts = services.marketStore.countByAsset();
    const instrumentCounts = services.instrumentStore.countByUnderlying();

    const enriched = assets.map(asset => ({
      ...asset,
      stats: {
        tracked_markets: marketCounts[asset.id] || 0,
        bull_instruments: instrumentCounts[asset.avanza_search.underlying_terms[0]]?.bull || 0,
        bear_instruments: instrumentCounts[asset.avanza_search.underlying_terms[0]]?.bear || 0
      }
    }));

    res.json({ version: 2, assets: enriched });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ontology' });
  }
});

// GET /api/ontology/:id - Get single asset
router.get('/:id', (req, res) => {
  try {
    const asset = services.ontology.getAsset(req.params.id);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json(asset);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch asset' });
  }
});

// Note: POST/PUT/DELETE for ontology editing would require
// file system write access and ontology reload logic

export default router;
