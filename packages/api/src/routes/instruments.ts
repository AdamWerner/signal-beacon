import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

// GET /api/instruments - Get all instruments
router.get('/', (req, res) => {
  try {
    const activeOnly = req.query.active !== 'false';
    const instruments = services.instrumentStore.findAll(activeOnly);

    res.json(instruments);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch instruments' });
  }
});

// GET /api/instruments/search - Search instruments
router.get('/search', (req, res) => {
  try {
    const query = req.query.q as string;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const underlying = query.toUpperCase();
    const direction = req.query.direction as 'bull' | 'bear' | undefined;

    const instruments = services.instrumentStore.findByUnderlying(underlying, direction);

    res.json(instruments);
  } catch (error) {
    res.status(500).json({ error: 'Failed to search instruments' });
  }
});

// GET /api/instruments/:avanzaId - Get single instrument
router.get('/:avanzaId', (req, res) => {
  try {
    const instrument = services.instrumentStore.findByAvanzaId(req.params.avanzaId);

    if (!instrument) {
      return res.status(404).json({ error: 'Instrument not found' });
    }

    res.json(instrument);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch instrument' });
  }
});

// GET /api/instruments/stats/by-underlying - Get instrument counts by underlying
router.get('/stats/by-underlying', (req, res) => {
  try {
    const counts = services.instrumentStore.countByUnderlying();
    res.json(counts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
