#!/usr/bin/env node
/**
 * Continuous scan loop.
 * - Every 10 minutes: scan cycle
 * - Every 6 hours: market refresh
 * - Every 24 hours: cleanup
 * - Every 30 minutes: tweet collection
 */

import 'dotenv/config';
import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');

const SCAN_INTERVAL_MS = 10 * 60 * 1000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INSTRUMENT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TWEET_COLLECTION_INTERVAL_MS = 30 * 60 * 1000;
const TWEET_EXPANSION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const SCAN_LOG = join(DATA_DIR, 'scan-log.txt');
const ERROR_LOG = join(DATA_DIR, 'error-log.txt');
const LOCK_FILE = join(DATA_DIR, 'continuous-scan.lock');

try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {
  // ignore
}

function logScan(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(SCAN_LOG, line);
  } catch {
    // ignore
  }
}

function logError(context, err) {
  const msg = err?.stack ?? err?.message ?? String(err);
  const line = `${new Date().toISOString()} [ERROR] ${context}: ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(ERROR_LOG, line);
  } catch {
    // ignore
  }
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLockOrExit() {
  if (existsSync(LOCK_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      const lockPid = Number(raw?.pid || 0);
      if (lockPid > 0 && isPidRunning(lockPid)) {
        logScan(`[fatal] another continuous scanner is already running (pid=${lockPid}). exiting.`);
        process.exit(1);
      }
    } catch {
      // stale/corrupt lock, overwrite below
    }
  }

  writeFileSync(
    LOCK_FILE,
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

function releaseLock() {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const raw = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (Number(raw?.pid) === process.pid) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // ignore
  }
}

acquireLockOrExit();

let scanner;
let IntelligenceEngine;
let isPreMarketWindow;

try {
  logScan('[init] loading scanner module...');
  const mod = await import('@polysignal/scanner');
  scanner = mod.scanner;

  const tradingHours = await import('../packages/scanner/dist/intelligence/trading-hours.js').catch(() => null);
  const engineMod = await import('../packages/scanner/dist/intelligence/engine.js').catch(() => null);

  isPreMarketWindow = tradingHours?.isPreMarketWindow;
  IntelligenceEngine = engineMod?.IntelligenceEngine;
  logScan('[init] scanner module loaded');
} catch (err) {
  releaseLock();
  logError('scanner init', err);
  logScan('[fatal] cannot load scanner - run npm run build:scanner');
  process.exit(1);
}

let lastRefreshAt = 0;
let lastCleanupAt = 0;
let lastInstrumentRefreshAt = 0;
let lastTweetCollectionAt = 0;
let lastTweetExpansionAt = 0;
let cycleCount = 0;

async function runOneCycle() {
  cycleCount += 1;
  const start = Date.now();

  if (Date.now() - lastRefreshAt > REFRESH_INTERVAL_MS) {
    try {
      logScan(`[cycle ${cycleCount}] running market refresh...`);
      await scanner.runMarketRefresh();
      lastRefreshAt = Date.now();
      logScan(`[cycle ${cycleCount}] market refresh complete`);
    } catch (err) {
      logError(`market refresh (cycle ${cycleCount})`, err);
    }

    if (scanner.getAvanzaAvailable() && Date.now() - lastInstrumentRefreshAt > INSTRUMENT_REFRESH_INTERVAL_MS) {
      try {
        logScan(`[cycle ${cycleCount}] running instrument refresh...`);
        await scanner.runInstrumentRefresh();
        lastInstrumentRefreshAt = Date.now();
        logScan(`[cycle ${cycleCount}] instrument refresh complete`);
      } catch (err) {
        logError(`instrument refresh (cycle ${cycleCount})`, err);
      }
    }
  }

  if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
    try {
      logScan(`[cycle ${cycleCount}] running cleanup...`);
      await scanner.runCleanup();
      lastCleanupAt = Date.now();
    } catch (err) {
      logError(`cleanup (cycle ${cycleCount})`, err);
    }
  }

  if (Date.now() - lastTweetExpansionAt > TWEET_EXPANSION_INTERVAL_MS) {
    try {
      const expansion = await scanner.runTweetUniverseExpansion(1200);
      lastTweetExpansionAt = Date.now();
      logScan(
        `[cycle ${cycleCount}] tweet universe expanded: count=${expansion.currentCount} ` +
        `seed_added=${expansion.insertedFromSeed} graph_added=${expansion.discoveredFromConnections}`
      );
    } catch (err) {
      logError(`tweet universe expansion (cycle ${cycleCount})`, err);
    }
  }

  await checkMorningBriefings();

  if (Date.now() - lastTweetCollectionAt > TWEET_COLLECTION_INTERVAL_MS) {
    try {
      logScan(`[cycle ${cycleCount}] collecting tweets...`);
      const tweetResult = await scanner.runTweetCollection();
      lastTweetCollectionAt = Date.now();
      logScan(
        `[cycle ${cycleCount}] tweets: processed=${tweetResult.accountsProcessed} collected=${tweetResult.tweetsCollected} ` +
        `new_accounts=${tweetResult.accountsAdded} connections=${tweetResult.connectionsAdded} universe=${tweetResult.universeCount} errors=${tweetResult.errors}`
      );
    } catch (err) {
      logError(`tweet collection (cycle ${cycleCount})`, err);
    }
  }

  try {
    const result = await scanner.runScanCycle();
    const duration = ((Date.now() - start) / 1000).toFixed(1);

    logScan(
      `[cycle ${cycleCount}] markets=${result.marketsTracked} changes=${result.oddsChangesDetected} ` +
      `whales=${result.whalesDetected} signals=${result.signalsGenerated} alerts=${result.alertsSent} duration=${duration}s`
    );
  } catch (err) {
    logError(`scan cycle ${cycleCount}`, err);
  }
}

async function checkMorningBriefings() {
  if (!isPreMarketWindow || !IntelligenceEngine) return;

  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  const haSvc = process.env.HA_NOTIFY_SERVICE;
  const pubUrl = process.env.PUBLIC_URL || 'http://192.168.0.15:3100';

  for (const market of ['swedish', 'us']) {
    if (!isPreMarketWindow(market)) continue;

    try {
      const services = scanner.getServices();
      const db = services?.db;
      if (!db) continue;

      const intel = new IntelligenceEngine(db);
      const existing = intel.getMorningBriefing(market);
      if (existing?.pushed_at) continue;

      logScan(`[briefing] generating ${market} morning briefing...`);

      try {
        const tweetResult = await scanner.runTweetProcessing();
        if (tweetResult.insightsGenerated > 0) {
          logScan(`[briefing] tweet intelligence: ${tweetResult.insightsGenerated} insights from ${tweetResult.tweetsAnalyzed} tweets`);
        }
      } catch (err) {
        logError(`tweet processing before briefing (${market})`, err);
      }

      const text = await intel.generateMorningBriefing(market);

      if (haUrl && haToken && haSvc) {
        const title = market === 'swedish' ? 'SE OMX Morning Brief' : 'US Market Brief';
        const servicePath = haSvc.replace('.', '/');
        const briefingUrl = `${pubUrl}/api/briefing/${market}`;

        try {
          const resp = await fetch(`${haUrl}/api/services/${servicePath}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${haToken}`,
              'Content-Type': 'application/json'
            },
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
  logScan('[start] polysignal continuous scan started');

  // one immediate refresh; skip immediate cleanup
  lastRefreshAt = -Infinity;
  lastCleanupAt = Date.now();

  while (true) {
    await runOneCycle();
    logScan(`[sleep] next scan in ${SCAN_INTERVAL_MS / 60000} minutes...`);
    await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL_MS));
  }
}

process.on('SIGINT', () => {
  logScan('[stop] received SIGINT - shutting down');
  releaseLock();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logScan('[stop] received SIGTERM - shutting down');
  releaseLock();
  process.exit(0);
});

process.on('exit', () => {
  releaseLock();
});

process.on('uncaughtException', err => {
  logError('uncaughtException', err);
});

process.on('unhandledRejection', reason => {
  logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

loop().catch(err => {
  releaseLock();
  logError('loop crash', err);
  process.exit(1);
});
