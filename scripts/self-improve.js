#!/usr/bin/env node
/**
 * Self-improvement log analyzer.
 * Reads the last 10 scan log entries and flags patterns that look wrong.
 * Writes notes to data/improvement-log.txt — for review only, does not auto-fix.
 */

import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scanner } from '@polysignal/scanner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const SCAN_LOG  = join(DATA_DIR, 'scan-log.txt');
const IMPROVE_LOG = join(DATA_DIR, 'improvement-log.txt');

function note(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(IMPROVE_LOG, line); } catch {}
}

if (!existsSync(SCAN_LOG)) {
  console.log('No scan-log.txt yet — nothing to analyze.');
  process.exit(0);
}

const raw = readFileSync(SCAN_LOG, 'utf8').trim().split('\n');
// Take last 10 scan-cycle lines (ignore sleep/start/refresh lines)
const cycleLines = raw.filter(l => l.includes('markets=')).slice(-10);

if (cycleLines.length === 0) {
  console.log('No completed scan cycles in log yet.');
  process.exit(0);
}

console.log(`Analyzing ${cycleLines.length} recent scan cycles...`);

// Parse cycle data
const cycles = cycleLines.map(line => {
  const m = s => { const r = line.match(new RegExp(`${s}=(\\S+)`)); return r ? r[1] : null; };
  return {
    markets:  parseInt(m('markets') ?? '0'),
    changes:  parseInt(m('changes') ?? '0'),
    whales:   parseInt(m('whales') ?? '0'),
    signals:  parseInt(m('signals') ?? '0'),
    duration: parseFloat(m('duration') ?? '0'),
    raw: line
  };
});

const issues = [];

// Check 1: no markets tracked
const zeroMarkets = cycles.filter(c => c.markets === 0);
if (zeroMarkets.length > 0) {
  issues.push(`${zeroMarkets.length} cycle(s) tracked 0 markets — market refresh may have failed or DB is empty.`);
}

// Check 2: slow scans (>600s = 10 min)
const slowScans = cycles.filter(c => c.duration > 600);
if (slowScans.length > 0) {
  issues.push(`${slowScans.length} cycle(s) took >10min (max: ${Math.max(...slowScans.map(c => c.duration))}s) — whale detector or odds tracker may be slow.`);
}

// Check 3: consistently 0 odds changes
const noChanges = cycles.filter(c => c.changes === 0 && c.markets > 0);
if (noChanges.length >= 3) {
  issues.push(`${noChanges.length} consecutive cycles with 0 odds changes — snapshots may be stale or time window too narrow.`);
}

// Check 4: 0 signals when there are changes
const changesButNoSignals = cycles.filter(c => c.changes > 0 && c.signals === 0);
if (changesButNoSignals.length >= 2) {
  issues.push(`${changesButNoSignals.length} cycle(s) had odds changes but generated 0 signals — ontology matching may be broken or threshold too high.`);
}

// Check 5: avg duration trend (is it getting slower?)
if (cycles.length >= 5) {
  const firstHalf  = cycles.slice(0, Math.floor(cycles.length / 2));
  const secondHalf = cycles.slice(Math.floor(cycles.length / 2));
  const avgFirst  = firstHalf.reduce((s, c) => s + c.duration, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, c) => s + c.duration, 0) / secondHalf.length;
  if (avgSecond > avgFirst * 1.5) {
    issues.push(`Scan duration trending up: ${avgFirst.toFixed(0)}s → ${avgSecond.toFixed(0)}s. Possible memory leak or accumulating DB load.`);
  }
}

if (issues.length === 0) {
  note('[OK] No issues detected in last 10 scan cycles.');
} else {
  note(`[ISSUES] ${issues.length} pattern(s) detected:`);
  issues.forEach(i => note(`  - ${i}`));
}

async function runBacktestLearning() {
  note('[learning] running daily backtest learning pass...');

  for (const market of ['swedish', 'us']) {
    try {
      const result = await scanner.runDailyBacktest(market);
      note(
        `[learning] ${market}: evaluated=${result.signalsEvaluated} ` +
        `hit30=${(result.hitRate30m * 100).toFixed(0)}% hit60=${(result.hitRate60m * 100).toFixed(0)}% ` +
        `avg60=${result.avgMove60m.toFixed(2)}%${result.skipped ? ' (cached)' : ''}`
      );

      if (result.aiNotes) {
        note(`[learning] ${market} ai-notes: ${result.aiNotes}`);
      }
    } catch (error) {
      note(`[learning] ${market} backtest failed: ${String(error)}`);
    }
  }

  try {
    const db = scanner.getServices().db;
    const top = db.prepare(`
      SELECT asset_name, samples, hit_rate_60m, suggested_confidence_adjustment
      FROM asset_performance
      WHERE samples >= 4
      ORDER BY hit_rate_60m DESC
      LIMIT 5
    `).all();
    const bottom = db.prepare(`
      SELECT asset_name, samples, hit_rate_60m, suggested_confidence_adjustment
      FROM asset_performance
      WHERE samples >= 4
      ORDER BY hit_rate_60m ASC
      LIMIT 5
    `).all();

    if (top.length > 0) {
      note('[learning] strongest assets:');
      for (const row of top) {
        note(
          `  - ${row.asset_name}: samples=${row.samples}, hit60=${(row.hit_rate_60m * 100).toFixed(0)}%, ` +
          `adj=${row.suggested_confidence_adjustment > 0 ? '+' : ''}${row.suggested_confidence_adjustment}`
        );
      }
    }

    if (bottom.length > 0) {
      note('[learning] weakest assets:');
      for (const row of bottom) {
        note(
          `  - ${row.asset_name}: samples=${row.samples}, hit60=${(row.hit_rate_60m * 100).toFixed(0)}%, ` +
          `adj=${row.suggested_confidence_adjustment > 0 ? '+' : ''}${row.suggested_confidence_adjustment}`
        );
      }
    }
  } catch (error) {
    note(`[learning] could not summarize asset performance: ${String(error)}`);
  }
}

await runBacktestLearning();
