import { Router } from 'express';
import { scanner, getClaudeUsage } from '@polysignal/scanner';
import { loadConfig } from '@polysignal/scanner/dist/config.js';

const router = Router();
const services = scanner.getServices();
const config = loadConfig();

// GET /api/health - Get system health and job status
router.get('/', (req, res) => {
  try {
    const marketStats = services.marketStore.getStats();
    const signalStats = services.signalStore.getStats();
    const instrumentCounts = services.instrumentStore.countByUnderlying() as Record<string, { bull: number; bear: number }>;

    const totalInstruments = Object.values(instrumentCounts).reduce(
      (sum, counts) => sum + counts.bull + counts.bear,
      0
    );

    const lastScanAt = services.signalStore.getLatestTimestamp();

    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      claude_cli_calls_today: getClaudeUsage().today,
      last_scan_at: lastScanAt,
      avanza: services.avanzaAvailable ? 'connected' : 'not connected',
      scanner: {
        markets: marketStats,
        signals: signalStats,
        instruments: {
          total: totalInstruments,
          by_underlying: instrumentCounts
        }
      },
      jobs: {
        scan_cycle: {
          schedule: config.jobScanCron
        },
        market_refresh: {
          schedule: config.jobMarketRefreshCron
        },
        instrument_refresh: {
          schedule: config.jobInstrumentRefreshCron,
          enabled: services.avanzaAvailable
        },
        cleanup: {
          schedule: config.jobCleanupCron
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch health status' });
  }
});

// POST /api/scan/trigger - Manually trigger a scan cycle
router.post('/scan/trigger', async (req, res) => {
  try {
    const result = await scanner.runScanCycle();
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: 'Scan failed', message: error.message });
  }
});

// POST /api/refresh/markets - Manually refresh markets
router.post('/refresh/markets', async (req, res) => {
  try {
    const result = await scanner.runMarketRefresh();
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: 'Market refresh failed', message: error.message });
  }
});

// POST /api/refresh/instruments - Manually refresh instruments
router.post('/refresh/instruments', async (req, res) => {
  try {
    const result = await scanner.runInstrumentRefresh();
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: 'Instrument refresh failed', message: error.message });
  }
});

export default router;
