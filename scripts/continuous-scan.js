#!/usr/bin/env node
/**
 * Continuous scan loop — runs forever until Ctrl+C.
 * Every 10 minutes: scan cycle
 * Every 6 hours: market refresh
 * Every 24 hours: cleanup
 *
 * Note: Start API separately with: npm run dev:api
 */

import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');

const SCAN_INTERVAL_MS  = 10 * 60 * 1000;   // 10 minutes
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const SCAN_LOG   = join(DATA_DIR, 'scan-log.txt');
const ERROR_LOG  = join(DATA_DIR, 'error-log.txt');

// Ensure data dir exists
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}

function logScan(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(SCAN_LOG, line); } catch {}
}

function logError(context, err) {
  const msg = err?.stack ?? err?.message ?? String(err);
  const line = `${new Date().toISOString()} [ERROR] ${context}: ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(ERROR_LOG, line); } catch {}
}

// Import scanner — wrap in try/catch to surface init failures clearly
let scanner;
let IntelligenceEngine;
let isPreMarketWindow;
try {
  logScan('[init] Loading scanner module...');
  const mod = await import('@polysignal/scanner');
  scanner = mod.scanner;
  // Intelligence helpers (compiled into scanner dist)
  const tradingHours = await import('../packages/scanner/dist/intelligence/trading-hours.js').catch(() => null);
  const engineMod = await import('../packages/scanner/dist/intelligence/engine.js').catch(() => null);
  isPreMarketWindow = tradingHours?.isPreMarketWindow;
  IntelligenceEngine = engineMod?.IntelligenceEngine;
  logScan('[init] Scanner module loaded OK');
} catch (err) {
  logError('scanner init', err);
  logScan('[fatal] Cannot load scanner — check build output (run npm run build:scanner)');
  process.exit(1);
}

let lastRefreshAt = 0;
let lastCleanupAt = 0;
let lastInstrumentRefreshAt = 0;
let cycleCount = 0;

const INSTRUMENT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function runOneCycle() {
  cycleCount++;
  const start = Date.now();

  // Market refresh every 6 hours
  if (Date.now() - lastRefreshAt > REFRESH_INTERVAL_MS) {
    try {
      logScan(`[cycle ${cycleCount}] Running market refresh...`);
      await scanner.runMarketRefresh();
      lastRefreshAt = Date.now();
      logScan(`[cycle ${cycleCount}] Market refresh complete`);
    } catch (err) {
      logError(`market refresh (cycle ${cycleCount})`, err);
      // Continue to scan cycle regardless
    }

    // Instrument refresh after market refresh (first time + every 24h)
    if (scanner.getAvanzaAvailable() && Date.now() - lastInstrumentRefreshAt > INSTRUMENT_REFRESH_INTERVAL_MS) {
      try {
        logScan(`[cycle ${cycleCount}] Running instrument refresh...`);
        await scanner.runInstrumentRefresh();
        lastInstrumentRefreshAt = Date.now();
        logScan(`[cycle ${cycleCount}] Instrument refresh complete`);
      } catch (err) {
        logError(`instrument refresh (cycle ${cycleCount})`, err);
      }
    }
  }

  // Cleanup every 24 hours
  if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
    try {
      logScan(`[cycle ${cycleCount}] Running cleanup...`);
      await scanner.runCleanup();
      lastCleanupAt = Date.now();
    } catch (err) {
      logError(`cleanup (cycle ${cycleCount})`, err);
    }
  }

  // Morning briefing check (before scan)
  await checkMorningBriefings();

  // Main scan
  try {
    const result = await scanner.runScanCycle();
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    logScan(
      `[cycle ${cycleCount}] markets=${result.marketsTracked} ` +
      `changes=${result.oddsChangesDetected} whales=${result.whalesDetected} ` +
      `signals=${result.signalsGenerated} alerts=${result.alertsSent} ` +
      `duration=${duration}s`
    );
  } catch (err) {
    logError(`scan cycle ${cycleCount}`, err);
  }
}

async function checkMorningBriefings() {
  if (!isPreMarketWindow || !IntelligenceEngine) return;

  const haUrl   = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  const haSvc   = process.env.HA_NOTIFY_SERVICE;
  const pubUrl  = process.env.PUBLIC_URL || 'http://192.168.0.15:3100';

  for (const market of ['swedish', 'us']) {
    if (!isPreMarketWindow(market)) continue;

    try {
      // Get db reference from scanner internals
      const services = scanner.getServices();
      if (!services) continue;
      const db = services.signalStore?.db;
      if (!db) continue;

      const intel = new IntelligenceEngine(db);
      const existing = intel.getMorningBriefing(market);
      if (existing?.pushed_at) continue; // already sent today

      logScan(`[briefing] Generating ${market} morning briefing...`);
      const text = await intel.generateMorningBriefing(market);

      if (haUrl && haToken && haSvc) {
        const title = market === 'swedish' ? '🇸🇪 OMX Morning Brief' : '🇺🇸 US Market Brief';
        const servicePath = haSvc.replace('.', '/');
        const briefingUrl = `${pubUrl}/api/briefing/${market}`;
        try {
          const resp = await fetch(`${haUrl}/api/services/${servicePath}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${haToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              message: text.substring(0, 400),
              data: { priority: 'high', url: briefingUrl, clickAction: briefingUrl }
            })
          });
          if (resp.ok) {
            intel.markBriefingPushed(market);
            logScan(`[briefing] ${market} briefing pushed`);
          }
        } catch (err) {
          logError(`briefing push (${market})`, err);
        }
      } else {
        logScan(`[briefing] ${market}: ${text.substring(0, 200)}`);
        intel.markBriefingPushed(market);
      }
    } catch (err) {
      logError(`morning briefing (${market})`, err);
    }
  }
}

async function loop() {
  logScan('[start] PolySignal continuous scan started');
  logScan('[info] Note: Start API separately with: npm run dev:api');

  // Run first refresh immediately
  lastRefreshAt = -Infinity;
  lastCleanupAt = Date.now(); // skip cleanup on first start

  while (true) {
    await runOneCycle();

    logScan(`[sleep] Next scan in ${SCAN_INTERVAL_MS / 60000} minutes...`);
    await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL_MS));
  }
}

process.on('SIGINT', () => {
  logScan('[stop] Received SIGINT — shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logScan('[stop] Received SIGTERM — shutting down gracefully');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
  // Don't exit — keep the loop alive
});

process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  // Don't exit — keep the loop alive
});

loop().catch(err => {
  logError('loop crash', err);
  process.exit(1);
});
