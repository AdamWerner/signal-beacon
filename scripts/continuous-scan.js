#!/usr/bin/env node
/**
 * Continuous scan loop — runs forever until Ctrl+C.
 * Every 10 minutes: scan cycle
 * Every 6 hours: market refresh
 * Every 24 hours: cleanup
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
  const line = `${new Date().toISOString()} [ERROR] ${context}: ${err?.message ?? err}\n`;
  process.stderr.write(line);
  try { appendFileSync(ERROR_LOG, line); } catch {}
}

// Lazy-import scanner after dotenv is loaded
const { scanner } = await import('@polysignal/scanner');

let lastRefreshAt = 0;
let lastCleanupAt = 0;
let cycleCount = 0;

async function runOneCycle() {
  cycleCount++;
  const start = Date.now();

  // Market refresh every 6 hours
  if (Date.now() - lastRefreshAt > REFRESH_INTERVAL_MS) {
    try {
      logScan(`[cycle ${cycleCount}] Running market refresh...`);
      await scanner.runMarketRefresh();
      lastRefreshAt = Date.now();
    } catch (err) {
      logError('market refresh', err);
    }
  }

  // Cleanup every 24 hours
  if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
    try {
      logScan(`[cycle ${cycleCount}] Running cleanup...`);
      await scanner.runCleanup();
      lastCleanupAt = Date.now();
    } catch (err) {
      logError('cleanup', err);
    }
  }

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

async function loop() {
  logScan('[start] PolySignal continuous scan started');

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

process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
  // Don't exit — keep the loop alive
});

loop().catch(err => {
  logError('loop crash', err);
  process.exit(1);
});
