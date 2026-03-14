#!/usr/bin/env node
/**
 * Policy optimizer:
 * - Re-runs push-only backtests for recent days
 * - Refreshes push-performance gates (open/watch/block)
 * - Logs policy drift over multiple iterations
 *
 * Usage:
 *   node scripts/policy-optimizer.js
 *   POLICY_ITERS=20 POLICY_DAYS=7 node scripts/policy-optimizer.js
 */

import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scanner } from '@polysignal/scanner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const LOG_FILE = join(DATA_DIR, 'policy-optimizer-log.txt');

const ITERATIONS = Math.max(1, parseInt(process.env.POLICY_ITERS || '20', 10));
const DAYS = Math.max(1, Math.min(30, parseInt(process.env.POLICY_DAYS || '7', 10)));
const SLEEP_MS = Math.max(0, parseInt(process.env.POLICY_SLEEP_MS || '0', 10));
const FORCE_FIRST_ONLY = (process.env.POLICY_FORCE_FIRST_ONLY || 'true').toLowerCase() !== 'false';

mkdirSync(DATA_DIR, { recursive: true });

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

function stockholmDateDaysAgo(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
}

async function runOneIteration(iteration) {
  log(`[iter ${iteration}] start days=${DAYS} mode=push_only`);
  const force = !FORCE_FIRST_ONLY || iteration === 1;

  let evaluatedSignals = 0;
  for (let daysAgo = 1; daysAgo <= DAYS; daysAgo += 1) {
    const date = stockholmDateDaysAgo(daysAgo);
    for (const market of ['swedish', 'us']) {
      const result = await scanner.runDailyBacktest(market, date, force);
      evaluatedSignals += result.skipped ? 0 : result.signalsEvaluated;
      log(
        `[iter ${iteration}] ${date} ${market} eval=${result.signalsEvaluated}` +
        `${result.skipped ? '(cached)' : ''} ` +
        `hit30=${(result.hitRate30m * 100).toFixed(0)}% hit60=${(result.hitRate60m * 100).toFixed(0)}% ` +
        `cand=${result.candidateSignals || 0} noPrice=${result.skippedNoPriceData || 0}`
      );
    }
  }

  const db = scanner.getServices().db;
  const gateStats = db.prepare(`
    SELECT gate, COUNT(*) as cnt
    FROM asset_push_performance
    GROUP BY gate
    ORDER BY cnt DESC
  `).all();

  const topOpen = db.prepare(`
    SELECT asset_name, samples, hit_rate_30m, avg_move_30m, reliability_score
    FROM asset_push_performance
    WHERE gate = 'open'
    ORDER BY reliability_score DESC, samples DESC
    LIMIT 5
  `).all();

  const blocked = db.prepare(`
    SELECT asset_name, samples, hit_rate_30m, avg_move_30m, reliability_score
    FROM asset_push_performance
    WHERE gate = 'block'
    ORDER BY samples DESC, reliability_score ASC
    LIMIT 8
  `).all();

  const policy = db.prepare(`
    SELECT market, min_confidence, min_delta_pct, min_evidence_score, optimization_score, sample_count, updated_at
    FROM push_policy_config
    ORDER BY market ASC
  `).all();

  log(
    `[iter ${iteration}] summary evaluated_signals=${evaluatedSignals} ` +
    `gates=${JSON.stringify(gateStats)}`
  );
  log(`[iter ${iteration}] push_policy=${JSON.stringify(policy)}`);
  if (topOpen.length > 0) {
    log(`[iter ${iteration}] top_open=${JSON.stringify(topOpen)}`);
  }
  if (blocked.length > 0) {
    log(`[iter ${iteration}] blocked_assets=${JSON.stringify(blocked)}`);
  }
}

async function main() {
  log(
    `[start] policy optimizer iterations=${ITERATIONS} days=${DAYS} ` +
    `force_first_only=${FORCE_FIRST_ONLY}`
  );
  for (let i = 1; i <= ITERATIONS; i += 1) {
    await runOneIteration(i);
    if (i < ITERATIONS && SLEEP_MS > 0) {
      log(`[iter ${i}] sleeping ${(SLEEP_MS / 1000).toFixed(0)}s`);
      await sleep(SLEEP_MS);
    }
  }
  log('[done] policy optimizer complete');
}

main().catch(error => {
  log(`[fatal] ${String(error)}`);
  process.exit(1);
});
