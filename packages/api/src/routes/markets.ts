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
