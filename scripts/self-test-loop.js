#!/usr/bin/env node
import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scanner } from '@polysignal/scanner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const LOG_FILE = join(DATA_DIR, 'self-test-log.txt');
const CYCLE_WAIT_MS = 10 * 60 * 1000;

mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.DRY_RUN) {
  process.env.DRY_RUN = 'true';
}

let keepRunning = true;
let globalCycle = 0;
const scriptStartDbTime = new Date().toISOString().slice(0, 19).replace('T', ' ');

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // ignore log write failures
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toDbTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function runScanSelfTestCycle() {
  globalCycle += 1;
  const cycleStart = new Date();
  const cycleStartDb = toDbTime(cycleStart);

  log(`[cycle ${globalCycle}] starting (DRY_RUN=${process.env.DRY_RUN})`);

  try {
    const tweetCollection = await scanner.runTweetCollection();
    log(
      `[cycle ${globalCycle}] tweets accounts=${tweetCollection.accountsProcessed} ` +
      `collected=${tweetCollection.tweetsCollected} errors=${tweetCollection.errors} ` +
      `universe=${tweetCollection.universeCount}`
    );
  } catch (error) {
    log(`[cycle ${globalCycle}] tweet collection failed: ${String(error)}`);
  }

  const scanResult = await scanner.runScanCycle();
  const db = scanner.getServices().db;

  const signalStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN verification_status = 'approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN verification_status = 'needs_review' THEN 1 ELSE 0 END) as needs_review,
      SUM(CASE WHEN verification_status = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN push_sent_at IS NOT NULL THEN 1 ELSE 0 END) as would_push
    FROM signals
    WHERE timestamp >= ?
  `).get(cycleStartDb);

  log(
    `[cycle ${globalCycle}] scan markets=${scanResult.marketsTracked} changes=${scanResult.oddsChangesDetected} ` +
    `signals=${scanResult.signalsGenerated} verified=${signalStats.approved || 0} ` +
    `review=${signalStats.needs_review || 0} rejected=${signalStats.rejected || 0} ` +
    `would_push=${signalStats.would_push || 0} duration=${(scanResult.duration / 1000).toFixed(1)}s`
  );
}

async function runDailyBacktests() {
  for (const market of ['swedish', 'us']) {
    try {
      const result = await scanner.runDailyBacktest(market);
      log(
        `[backtest] ${market} date=${result.date} evaluated=${result.signalsEvaluated} ` +
        `hit30=${(result.hitRate30m * 100).toFixed(0)}% hit60=${(result.hitRate60m * 100).toFixed(0)}% ` +
        `avg30=${result.avgMove30m.toFixed(2)} avg60=${result.avgMove60m.toFixed(2)} ` +
        `${result.skipped ? '(cached)' : ''}`
      );
    } catch (error) {
      log(`[backtest] ${market} failed: ${String(error)}`);
    }
  }
}

function runFeedHealthReport() {
  const db = scanner.getServices().db;
  const rows = db.prepare(`
    SELECT
      ta.handle,
      ta.display_name,
      ta.feed_url,
      COUNT(ts.id) as item_count
    FROM tweet_accounts ta
    LEFT JOIN tweet_snapshots ts
      ON ts.account_handle = ta.handle
     AND ts.scraped_at >= ?
    WHERE ta.collect_enabled = TRUE
      AND ta.feed_url IS NOT NULL
      AND ta.feed_url != ''
    GROUP BY ta.handle, ta.display_name, ta.feed_url
    ORDER BY item_count DESC, ta.handle ASC
  `).all(scriptStartDbTime);

  const healthy = rows.filter(row => row.item_count > 0);
  const zero = rows.filter(row => row.item_count === 0);

  log(
    `[feed-health] collect_enabled=${rows.length} healthy=${healthy.length} zero=${zero.length} ` +
    `window_start=${scriptStartDbTime}`
  );

  const topHealthy = healthy.slice(0, 12).map(row => `${row.handle}:${row.item_count}`);
  const topZero = zero.slice(0, 20).map(row => row.handle);

  if (topHealthy.length > 0) {
    log(`[feed-health] active_feeds ${topHealthy.join(', ')}`);
  }
  if (topZero.length > 0) {
    log(`[feed-health] zero_feeds ${topZero.join(', ')}`);
  }
}

async function main() {
  log('[start] self-test loop started');

  while (keepRunning) {
    for (let i = 0; i < 3 && keepRunning; i += 1) {
      const cycleLoopStart = Date.now();
      await runScanSelfTestCycle();
      if (!keepRunning || i === 2) break;

      const elapsed = Date.now() - cycleLoopStart;
      const sleepMs = Math.max(0, CYCLE_WAIT_MS - elapsed);
      log(`[cycle ${globalCycle}] sleeping ${(sleepMs / 1000).toFixed(0)}s before next cycle`);
      if (sleepMs > 0) {
        await sleep(sleepMs);
      }
    }

    if (!keepRunning) break;

    await runDailyBacktests();
    runFeedHealthReport();
  }

  log('[stop] self-test loop stopped');
}

process.on('SIGINT', () => {
  keepRunning = false;
  scanner.shutdown?.();
});

process.on('SIGTERM', () => {
  keepRunning = false;
  scanner.shutdown?.();
});

main().catch(error => {
  log(`[fatal] self-test loop crashed: ${String(error)}`);
  scanner.shutdown?.();
  process.exit(1);
});
