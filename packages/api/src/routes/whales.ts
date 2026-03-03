import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

// GET /api/whales - Get recent whale events
router.get('/', (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const limit = parseInt(req.query.limit as string) || 100;

    const whales = services.whaleStore.findRecent(hours, limit);

    res.json(whales);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch whale events' });
  }
});

// GET /api/whales/market/:conditionId - Get whales for a specific market
router.get('/market/:conditionId', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const whales = services.whaleStore.findByMarket(req.params.conditionId, limit);

    res.json(whales);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch whale events' });
  }
});

export default router;
