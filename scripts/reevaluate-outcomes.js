#!/usr/bin/env node
/**
 * One-off push-outcome threshold migration.
 *
 * Recomputes hit_tp / hit_sl / tp_first for already evaluated outcomes using
 * the current underlying-move thresholds. Raw max_favorable_pct,
 * max_adverse_pct, and net_max_favorable_pct are left unchanged.
 *
 * Run manually:
 *   node scripts/reevaluate-outcomes.js
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const TP_THRESHOLD_PCT = parseFloat(process.env.PUSH_TP_UNDERLYING_PCT || '1.5');
const SL_THRESHOLD_PCT = parseFloat(process.env.PUSH_SL_UNDERLYING_PCT || '1.0');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_PATH = join(ROOT, 'data', 'polysignal.db');

const PRICE_BUCKETS = [
  { minutes: 10, column: 'price_at_10m' },
  { minutes: 30, column: 'price_at_30m' },
  { minutes: 60, column: 'price_at_60m' },
  { minutes: 120, column: 'price_at_120m' },
  { minutes: 180, column: 'price_at_180m' },
  { minutes: 240, column: 'price_at_240m' }
];

if (!existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  process.exit(2);
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asDirection(value) {
  return String(value || '').toLowerCase().includes('bear') ? 'bear' : 'bull';
}

function directionalMovePct(entry, price, direction) {
  const raw = ((price - entry) / entry) * 100;
  return direction === 'bull' ? raw : -raw;
}

function computeNetFavorable(row) {
  const net = asNumber(row.net_max_favorable_pct);
  if (net !== null) return net;

  const maxFavorable = asNumber(row.max_favorable_pct);
  if (maxFavorable === null) return null;

  const roundTripCost = asNumber(row.estimated_round_trip_cost_pct) ?? 0;
  return maxFavorable - (roundTripCost * 100);
}

function summarize(rows) {
  const count = rows.length;
  const wins = rows.filter(row => Number(row.tp_first || 0) === 1).length;
  const netValues = rows
    .map(computeNetFavorable)
    .filter(value => value !== null);

  return {
    count,
    hitRate: count > 0 ? wins / count : null,
    avgNetFavorable: netValues.length > 0
      ? netValues.reduce((sum, value) => sum + value, 0) / netValues.length
      : null
  };
}

function formatPct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatMove(value) {
  return value === null ? 'n/a' : `${value.toFixed(2)}%`;
}

function printSummary(label, summary) {
  console.log(`${label}: count=${summary.count}, hit_rate=${formatPct(summary.hitRate)}, avg_net_favorable=${formatMove(summary.avgNetFavorable)}`);
}

function recomputeThresholdFlags(row) {
  const entry = asNumber(row.price_at_push);
  if (entry === null || entry <= 0) return null;

  const direction = asDirection(row.direction);
  let firstTpMinutes = null;
  let firstSlMinutes = null;

  for (const bucket of PRICE_BUCKETS) {
    const price = asNumber(row[bucket.column]);
    if (price === null || price <= 0) continue;

    const movePct = directionalMovePct(entry, price, direction);
    if (firstTpMinutes === null && movePct >= TP_THRESHOLD_PCT) {
      firstTpMinutes = bucket.minutes;
    }
    if (firstSlMinutes === null && movePct <= -SL_THRESHOLD_PCT) {
      firstSlMinutes = bucket.minutes;
    }
  }

  const hitTp = firstTpMinutes !== null;
  const hitSl = firstSlMinutes !== null;
  const tpFirst = hitTp && (!hitSl || firstTpMinutes <= firstSlMinutes);

  return {
    hitTp: hitTp ? 1 : 0,
    hitSl: hitSl ? 1 : 0,
    tpFirst: tpFirst ? 1 : 0
  };
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const rows = db.prepare(`
  SELECT
    signal_id,
    direction,
    price_at_push,
    price_at_10m,
    price_at_30m,
    price_at_60m,
    price_at_120m,
    price_at_180m,
    price_at_240m,
    hit_tp,
    hit_sl,
    tp_first,
    max_favorable_pct,
    net_max_favorable_pct,
    estimated_round_trip_cost_pct
  FROM push_outcomes
  WHERE evaluated_at IS NOT NULL
`).all();

const before = summarize(rows);
let updated = 0;
let skipped = 0;

const update = db.prepare(`
  UPDATE push_outcomes
  SET hit_tp = ?,
      hit_sl = ?,
      tp_first = ?
  WHERE signal_id = ?
`);

const tx = db.transaction((items) => {
  for (const row of items) {
    const flags = recomputeThresholdFlags(row);
    if (!flags) {
      skipped += 1;
      continue;
    }

    update.run(flags.hitTp, flags.hitSl, flags.tpFirst, row.signal_id);
    updated += 1;
  }
});

tx(rows);

const afterRows = db.prepare(`
  SELECT
    signal_id,
    direction,
    hit_tp,
    hit_sl,
    tp_first,
    max_favorable_pct,
    net_max_favorable_pct,
    estimated_round_trip_cost_pct
  FROM push_outcomes
  WHERE evaluated_at IS NOT NULL
`).all();

console.log('Push outcome TP/SL reevaluation');
console.log(`Thresholds: TP >= ${TP_THRESHOLD_PCT}% underlying, SL <= -${SL_THRESHOLD_PCT}% underlying`);
printSummary('Before', before);
printSummary('After ', summarize(afterRows));
console.log(`Rows updated: ${updated}, skipped: ${skipped}`);

db.close();
