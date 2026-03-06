#!/usr/bin/env node
/**
 * System health test — runs a single DRY_RUN cycle and reports pipeline state.
 * Usage: npm run system-test
 * Expected runtime: < 5 minutes.
 */

import 'dotenv/config';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

process.env.DRY_RUN = 'true';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PASS = '✓';
const FAIL = '✗';
const WARN = '⚠';

let warnings = 0;
let failures = 0;

function ok(label, value) {
  console.log(`  ${PASS} ${label}: ${value}`);
}
function warn(label, value) {
  warnings++;
  console.log(`  ${WARN} ${label}: ${value}`);
}
function fail(label, value) {
  failures++;
  console.log(`  ${FAIL} ${label}: ${value}`);
}

// ─── 1. Import scanner ────────────────────────────────────────────────────────
console.log('\n[1/8] Loading scanner module...');
let scanner;
try {
  const mod = await import('@polysignal/scanner');
  scanner = mod.scanner;
  ok('Scanner module', 'loaded');
} catch (err) {
  console.error(`  ${FAIL} Scanner load failed: ${err.message}`);
  console.error('  Run: npm run build:scanner');
  process.exit(1);
}

const services = scanner.getServices();
const db = services.db;

// ─── 2. DB health ─────────────────────────────────────────────────────────────
console.log('\n[2/8] Database...');
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  ok('Tables', tables.map(t => t.name).join(', '));

  const dbPath = join(ROOT, 'data', 'polysignal.db');
  if (!existsSync(dbPath)) warn('DB file', 'not found at data/polysignal.db');
  else ok('DB file', dbPath);
} catch (err) {
  fail('DB', err.message);
}

// ─── 3. Markets ───────────────────────────────────────────────────────────────
console.log('\n[3/8] Markets...');
try {
  const markets = services.marketStore.findAll(true);
  const total = services.marketStore.findAll(false).length;
  if (markets.length === 0) {
    warn('Active markets', `0 of ${total} — run market refresh`);
  } else {
    ok('Active markets', `${markets.length} of ${total} total`);
  }
} catch (err) {
  fail('Markets', err.message);
}

// ─── 4. Signals (last 24h) ────────────────────────────────────────────────────
console.log('\n[4/8] Signals (last 24h)...');
try {
  const rows = db.prepare(`
    SELECT verification_status, COUNT(*) as cnt, AVG(confidence) as avg_conf
    FROM signals
    WHERE timestamp >= datetime('now', '-24 hours')
    GROUP BY verification_status
  `).all();

  if (rows.length === 0) {
    warn('Signals', 'none in last 24h — may be early in day or filters are too strict');
  } else {
    for (const row of rows) {
      ok(`  ${row.verification_status}`, `${row.cnt} signals, avg confidence ${Math.round(row.avg_conf || 0)}%`);
    }
  }

  const pushed = db.prepare(`
    SELECT COUNT(*) as cnt FROM signals
    WHERE timestamp >= datetime('now', '-24 hours') AND push_sent_at IS NOT NULL
  `).get();
  ok('Pushed to HA', pushed.cnt);
} catch (err) {
  fail('Signals', err.message);
}

// ─── 5. News feeds (last 24h) ─────────────────────────────────────────────────
console.log('\n[5/8] News feeds...');
try {
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM tweet_accounts WHERE collect_enabled = 1`).get();
  const active = db.prepare(`
    SELECT COUNT(DISTINCT account_handle) as cnt FROM tweet_snapshots
    WHERE collected_at >= datetime('now', '-24 hours')
  `).get();
  const items = db.prepare(`
    SELECT COUNT(*) as cnt FROM tweet_snapshots
    WHERE collected_at >= datetime('now', '-24 hours')
  `).get();

  if (active.cnt === 0) {
    warn('Active feeds', `0 of ${total.cnt} enabled — check collector or news-sources.json`);
  } else {
    ok('Active feeds', `${active.cnt} of ${total.cnt} enabled`);
    ok('Items collected (24h)', items.cnt);
  }
} catch (err) {
  fail('News feeds', err.message);
}

// ─── 6. Avanza instruments ────────────────────────────────────────────────────
console.log('\n[6/8] Avanza instruments...');
try {
  const counts = services.instrumentStore.countByUnderlying();
  const total = Object.values(counts).reduce((s, c) => s + c.bull + c.bear, 0);
  if (total === 0) {
    warn('Instruments', '0 — Avanza may not be connected or instruments not refreshed');
  } else {
    ok('Instruments', `${total} total (${Object.keys(counts).length} underlyings)`);
  }
  ok('Avanza status', services.avanzaAvailable ? 'connected' : 'not connected');
} catch (err) {
  fail('Instruments', err.message);
}

// ─── 7. DRY_RUN scan cycle ────────────────────────────────────────────────────
console.log('\n[7/8] DRY_RUN scan cycle...');
try {
  const start = Date.now();
  const result = await scanner.runScanCycle();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  ok('Duration', `${elapsed}s`);
  ok('Markets tracked', result.marketsTracked);
  ok('Odds changes detected', result.oddsChangesDetected);
  ok('Signals generated', result.signalsGenerated);

  if (result.haPushed > 0) {
    ok('Would push to HA', result.haPushed);
  } else if (result.brewed > 0) {
    ok('Brewed (market closed)', result.brewed);
  } else {
    ok('HA push', 'none (DRY_RUN or below threshold)');
  }

  if (result.signalsGenerated === 0 && result.oddsChangesDetected > 0) {
    warn('Signal generation', 'odds changes detected but no signals generated — check ontology / thresholds');
  }
} catch (err) {
  fail('Scan cycle', err.message);
}

// ─── 8. Backtest (yesterday) ──────────────────────────────────────────────────
console.log('\n[8/8] Backtest (yesterday)...');
try {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yDate = yesterday.toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });

  for (const market of ['swedish', 'us']) {
    const result = await scanner.runDailyBacktest(market, yDate, false);
    if (result.skipped) {
      ok(`${market} (${yDate})`, `cached — ${result.signalsEvaluated} signals, hit rate 30m=${(result.hitRate30m * 100).toFixed(0)}%`);
    } else if (result.signalsEvaluated === 0) {
      warn(`${market} (${yDate})`, '0 signals evaluated — no qualifying signals yesterday');
    } else {
      ok(`${market} (${yDate})`, `${result.signalsEvaluated} signals, hit rate 30m=${(result.hitRate30m * 100).toFixed(0)}% 60m=${(result.hitRate60m * 100).toFixed(0)}%`);
    }
  }
} catch (err) {
  fail('Backtest', err.message);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(50));
if (failures > 0) {
  console.log(`SYSTEM STATUS: ${FAIL} DEGRADED (${failures} failure${failures > 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''})`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`SYSTEM STATUS: ${WARN} OK with ${warnings} warning${warnings !== 1 ? 's' : ''}`);
} else {
  console.log(`SYSTEM STATUS: ${PASS} HEALTHY`);
}
console.log('═'.repeat(50) + '\n');
