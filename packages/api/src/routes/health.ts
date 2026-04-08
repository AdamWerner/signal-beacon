import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scanner, getClaudeUsage, getAiBudgetMode } from '@polysignal/scanner';
import { loadConfig } from '@polysignal/scanner/dist/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HEARTBEAT_FILE = join(__dirname, '../../../../data/scanner-heartbeat.txt');
const HEARTBEAT_STALE_SECONDS = 900; // 15 min — two missed cycles

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

    let scannerHeartbeat: { heartbeat: string | null; ageSeconds: number | null; stale: boolean } = {
      heartbeat: null,
      ageSeconds: null,
      stale: true
    };
    try {
      const raw = readFileSync(HEARTBEAT_FILE, 'utf-8').trim();
      const ts = Date.parse(raw);
      if (Number.isFinite(ts)) {
        const ageSeconds = Math.round((Date.now() - ts) / 1000);
        scannerHeartbeat = {
          heartbeat: raw,
          ageSeconds,
          stale: ageSeconds > HEARTBEAT_STALE_SECONDS
        };
      }
    } catch {
      // file does not exist yet (scanner hasn't run)
    }

    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      claude_cli_calls_today: getClaudeUsage().today,
      ai_budget_mode: getAiBudgetMode(),
      source_health: (services.sourceDiagnostics as any)?.getSourceHealth?.() ?? [],
      last_scan_at: lastScanAt,
      avanza: services.avanzaAvailable ? 'connected' : 'not connected',
      scanner_heartbeat: scannerHeartbeat,
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
