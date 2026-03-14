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
    const hasRuntimeHealth = runtimeHealth.length > 0;
    const now = Date.now();
    const parseRowTime = (row: any): number => {
      const raw = String(row.last_message_at || row.updated_at || '');
      const normalized = raw.includes('T') || raw.endsWith('Z')
        ? raw
        : `${raw.replace(' ', 'T')}Z`;
      return Date.parse(normalized);
    };
    const freshWindowMs = 5 * 60 * 1000;
    const freshDbHealth = dbHealth.filter((row: any) => {
      const updatedAt = parseRowTime(row);
      return Number.isFinite(updatedAt) && (now - updatedAt) <= freshWindowMs;
    });
    const newestDbTimestamp = dbHealth.reduce((latest: number, row: any) => {
      const parsed = parseRowTime(row);
      return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
    }, 0);
    const staleMinutes = newestDbTimestamp > 0
      ? Math.max(0, Math.round((now - newestDbTimestamp) / 60000))
      : null;
    const enabled = hasRuntimeHealth || freshDbHealth.length > 0;
    const runtimeFallback = hasRuntimeHealth
      ? runtimeHealth
      : freshDbHealth.map((row: any) => ({
          component: row.component,
          status: row.status,
          details: row.details,
          lastMessageAt: parseRowTime(row)
        }));
    const mode = hasRuntimeHealth
      ? 'runtime'
      : (freshDbHealth.length > 0 ? 'database' : (dbHealth.length > 0 ? 'stale' : 'disabled'));
    const message = mode === 'stale'
      ? `Streaming health exists in the database but is stale (${staleMinutes ?? '?'} min old). Restart the continuous scanner or check the websocket collectors.`
      : mode === 'disabled'
        ? 'Streaming layer is not running. Phase 1 fallback is active.'
        : null;

    res.json({
      enabled,
      db: dbHealth,
      runtime: runtimeFallback,
      mode,
      staleMinutes,
      message
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
