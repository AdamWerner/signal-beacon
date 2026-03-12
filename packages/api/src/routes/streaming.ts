import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices() as any;

router.get('/health', (_req, res) => {
  try {
    const store = services.streamingStore;
    const supervisor = services.streamingSupervisor;
    const dbHealth = store ? store.getStreamingHealth() : [];
    const runtimeHealth = supervisor ? supervisor.getHealthStates() : [];
    res.json({
      enabled: Boolean(supervisor),
      db: dbHealth,
      runtime: runtimeHealth
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch streaming health', message: error?.message });
  }
});

router.get('/snapshots/:symbol', (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const store = services.streamingStore;
    if (!store) return res.status(503).json({ error: 'Streaming store unavailable' });
    const latest1s = store.getLatestSnapshot(symbol);
    const latest1m = store.getLatestSnapshot1m(symbol);
    res.json({ symbol, latest1s, latest1m });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch snapshot', message: error?.message });
  }
});

router.get('/confirmations', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || '20'), 10)));
    const store = services.streamingStore;
    if (!store) return res.status(503).json({ error: 'Streaming store unavailable' });
    res.json(store.getTopCurrentConfirmationStates(limit));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch confirmation states', message: error?.message });
  }
});

router.get('/leader-lag/:symbol', (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const store = services.streamingStore;
    if (!store) return res.status(503).json({ error: 'Streaming store unavailable' });
    res.json(store.getLatestLeaderLag(symbol));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch leader-lag', message: error?.message });
  }
});

export default router;

