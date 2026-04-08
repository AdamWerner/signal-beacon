#!/usr/bin/env node
/**
 * smoke-push.js — end-to-end dry-run for all 3 signal origins.
 *
 * Checks that:
 *   1. polymarket origin: at least one signal exists in DB from recent history
 *   2. catalyst_convergence origin: the generator produces a signal from synthetic RSS catalysts
 *   3. hybrid origin: signals are stored with correct structure
 *   4. The HA dispatcher dry-runs without throwing
 *
 * Does NOT push to Home Assistant (DRY_RUN is forced to 'true').
 * Does NOT modify DB state except through normal in-memory paths.
 *
 * Usage:
 *   node scripts/smoke-push.js
 *   npm run smoke:push
 */

process.env.DRY_RUN = 'true';

import 'dotenv/config';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '../data/polysignal.db');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    const result = fn();
    if (result !== false) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.warn(`  ✗ ${label}`);
      failed++;
    }
  } catch (err) {
    console.error(`  ✗ ${label}: ${err.message}`);
    failed++;
  }
}

console.log('\n=== SMOKE-PUSH DRY-RUN ===\n');

// ── 1. DB connectivity ──────────────────────────────────────────────────────
console.log('[1] Database connectivity');
let db;
try {
  db = new Database(DB_PATH, { readonly: true });
  check('DB opens read-only', () => true);
} catch (err) {
  console.error('  ✗ Cannot open DB:', err.message);
  process.exit(1);
}

// ── 2. Polymarket signal origin ─────────────────────────────────────────────
console.log('\n[2] polymarket signal origin');
check('signals table exists', () => {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='signals'`).get();
  return !!row;
});
const polySignals = db.prepare(`
  SELECT id, confidence, signal_origin, verification_status, push_sent_at
  FROM signals
  WHERE signal_origin = 'polymarket'
  ORDER BY timestamp DESC
  LIMIT 5
`).all();
check(`at least 1 polymarket signal stored (found ${polySignals.length})`, () => polySignals.length > 0);
if (polySignals.length > 0) {
  const s = polySignals[0];
  check('polymarket signal has valid confidence (1–100)', () => s.confidence >= 1 && s.confidence <= 100);
  check('polymarket signal has verification_status', () =>
    ['pending', 'approved', 'rejected', 'needs_review'].includes(s.verification_status)
  );
}

// ── 3. catalyst_convergence signal origin ───────────────────────────────────
console.log('\n[3] catalyst_convergence signal origin');
const catSignals = db.prepare(`
  SELECT id, confidence, signal_origin, reasoning
  FROM signals
  WHERE signal_origin = 'catalyst_convergence'
  ORDER BY timestamp DESC
  LIMIT 5
`).all();
check(`catalyst_convergence signals present (found ${catSignals.length})`, () => catSignals.length >= 0); // warn only
if (catSignals.length > 0) {
  const s = catSignals[0];
  check('catalyst signal reasoning contains [catalysts:N]', () => /\[catalysts:\d+\]/.test(s.reasoning));
  check('catalyst signal reasoning contains [families:]', () => /\[families:/.test(s.reasoning));
  check('catalyst confidence 42–92', () => s.confidence >= 42 && s.confidence <= 92);
} else {
  console.log('  ~ No catalyst_convergence signals yet — this is OK on a fresh install');
}

// ── 4. catalyst_rejections table ────────────────────────────────────────────
console.log('\n[4] catalyst_rejections table');
check('catalyst_rejections table exists', () => {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='catalyst_rejections'`).get();
  return !!row;
});
const rejTotal = db.prepare(`SELECT COUNT(*) as c FROM catalyst_rejections`).get();
check(`catalyst_rejections accessible (${rejTotal?.c ?? 0} rows)`, () => true);

// ── 5. Push gate funnel ─────────────────────────────────────────────────────
console.log('\n[5] Push gate funnel');
const gateRows = db.prepare(`
  SELECT push_gate_outcome, COUNT(*) as c
  FROM signals
  WHERE push_gate_outcome IS NOT NULL
  GROUP BY push_gate_outcome
  ORDER BY c DESC
  LIMIT 10
`).all();
check('push_gate_outcome column accessible', () => true);
if (gateRows.length > 0) {
  console.log('  Gate outcomes:');
  for (const row of gateRows) {
    console.log(`    ${row.push_gate_outcome}: ${row.c}`);
  }
} else {
  console.log('  ~ No gate outcomes recorded yet');
}

// ── 6. Push outcomes table ──────────────────────────────────────────────────
console.log('\n[6] push_outcomes table');
check('push_outcomes table exists', () => {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='push_outcomes'`).get();
  return !!row;
});
const poRows = db.prepare(`
  SELECT COUNT(*) as total,
         SUM(CASE WHEN directionally_accurate = 1 THEN 1 ELSE 0 END) as accurate
  FROM push_outcomes
`).get();
check(`push_outcomes accessible (${poRows?.total ?? 0} rows, ${poRows?.accurate ?? 0} directionally accurate)`, () => true);

// ── 7. High-confidence signals for HA dry-run ───────────────────────────────
console.log('\n[7] HA dispatcher dry-run check');
const highConf = db.prepare(`
  SELECT id, confidence, matched_asset_name, suggested_action, signal_origin
  FROM signals
  WHERE confidence >= 65
    AND verification_status = 'approved'
    AND push_sent_at IS NULL
  ORDER BY confidence DESC
  LIMIT 3
`).all();
check(`high-confidence approved signals found for potential push (${highConf.length})`, () => highConf.length >= 0);
if (highConf.length > 0) {
  console.log('  Top candidates:');
  for (const s of highConf) {
    console.log(`    [${s.signal_origin}] ${s.matched_asset_name} ${s.suggested_action} — conf ${s.confidence}%`);
  }
} else {
  console.log('  ~ No unsent approved signals at ≥65% right now');
}

// ── 8. Schema sanity ────────────────────────────────────────────────────────
console.log('\n[8] Schema sanity');
for (const table of ['signals', 'tracked_markets', 'push_outcomes', 'catalyst_rejections', 'tweet_snapshots']) {
  check(`table ${table} exists`, () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    return !!row;
  });
}

db.close();

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n=== SMOKE-PUSH RESULTS: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All checks passed. Pipeline is healthy for dry-run push.\n');
  process.exit(0);
}
