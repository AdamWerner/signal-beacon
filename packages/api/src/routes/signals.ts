import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

// GET /api/signals - Get all signals
router.get('/', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const status = req.query.status as any;

    const signals = services.signalStore.findAll(limit, status);

    // Parse JSON fields
    const parsed = signals.map(signal => ({
      ...signal,
      suggested_instruments: JSON.parse(signal.suggested_instruments)
    }));

    res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

// GET /api/signals/:id - Get single signal
router.get('/:id', (req, res) => {
  try {
    const signal = services.signalStore.findById(req.params.id);

    if (!signal) {
      return res.status(404).json({ error: 'Signal not found' });
    }

    res.json({
      ...signal,
      suggested_instruments: JSON.parse(signal.suggested_instruments)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch signal' });
  }
});

// PUT /api/signals/:id/status - Update signal status
router.put('/:id/status', (req, res) => {
  try {
    const { status } = req.body;

    if (!['new', 'viewed', 'dismissed', 'acted'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    services.signalStore.updateStatus(req.params.id, status);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update signal' });
  }
});

// GET /api/signals/stats - Get signal statistics
router.get('/stats', (req, res) => {
  try {
    const stats = services.signalStore.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
