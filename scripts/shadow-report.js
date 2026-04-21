#!/usr/bin/env node

import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DB_PATH = process.env.POLYSIGNAL_DB_PATH || path.join(ROOT_DIR, 'data', 'polysignal.db');
const HEARTBEAT_PATH = process.env.POLYSIGNAL_HEARTBEAT_PATH || path.join(ROOT_DIR, 'data', 'scanner-heartbeat.txt');
const SCAN_LOG_PATH = process.env.POLYSIGNAL_SCAN_LOG_PATH || path.join(ROOT_DIR, 'data', 'scan-log.txt');

function formatNumber(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a';
  return Number(value).toFixed(digits);
}

function formatPct(value, digits = 1) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function wilsonLowerBound(successes, total, z = 1.96) {
  if (!total) return 0;
  const phat = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = phat + z2 / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total);
  return (centre - margin) / denominator;
}

function parseMaybeJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function countTradingDaysSince(startIso) {
  if (!startIso) return 0;
  const start = new Date(startIso);
  const end = new Date();
  if (!Number.isFinite(start.getTime()) || start > end) return 0;

  let count = 0;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 12));
  const endDate = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 12));
  while (cursor <= endDate) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function getHeartbeatAge() {
  try {
    const raw = fs.readFileSync(HEARTBEAT_PATH, 'utf8').trim();
    const parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) {
      return { raw, ageMinutes: null };
    }
    return {
      raw,
      ageMinutes: Math.round((Date.now() - parsed.getTime()) / 60000)
    };
  } catch (error) {
    return { raw: `missing (${error.message})`, ageMinutes: null };
  }
}

function getScanLogStats() {
  try {
    const raw = fs.readFileSync(SCAN_LOG_PATH, 'utf8');
    const lines = raw.split(/\r?\n/);
    const cycleMatches = [...raw.matchAll(/\[cycle\s+(\d+)\]/gi)];
    const lastCycle = cycleMatches.length > 0 ? Number(cycleMatches[cycleMatches.length - 1][1]) : null;
    const timeoutPatterns = /timeout|ECONNRESET|killed|did not complete/i;
    const recentTimeouts = lines.filter(line => timeoutPatterns.test(line)).slice(-20);
    return {
      lastCycle,
      timeoutCount: recentTimeouts.length,
      timeoutSample: recentTimeouts.slice(-3)
    };
  } catch (error) {
    return {
      lastCycle: null,
      timeoutCount: 0,
      timeoutSample: [`missing (${error.message})`]
    };
  }
}

function loadReport(db) {
  const firstShadow = db.prepare(`
    SELECT MIN(shadow_push_at) AS first_shadow_push_at
    FROM push_outcomes
    WHERE COALESCE(is_shadow, 0) = 1
  `).get();

  const funnel = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM signals WHERE timestamp >= datetime('now', '-7 days')) AS signals_generated,
      (SELECT COUNT(*) FROM signals WHERE push_gate_outcome LIKE 'shadow_push:%' AND timestamp >= datetime('now', '-7 days')) AS signals_reaching_shadow_gate,
      (SELECT COUNT(*) FROM push_outcomes WHERE COALESCE(is_shadow, 0) = 1 AND shadow_push_at >= datetime('now', '-7 days')) AS shadow_rows_created,
      (SELECT COUNT(*) FROM push_outcomes WHERE COALESCE(is_shadow, 0) = 1 AND evaluated_at IS NOT NULL AND shadow_push_at >= datetime('now', '-7 days')) AS shadow_rows_evaluated,
      (SELECT COUNT(*) FROM push_outcomes
         WHERE COALESCE(is_shadow, 0) = 1
           AND evaluated_at IS NULL
           AND COALESCE(entry_anchor_ts, shadow_push_at, push_timestamp) <= datetime('now', '-24 hours')
      ) AS pending_shadow_over_24h
  `).get();

  const slices = db.prepare(`
    SELECT
      COALESCE(signal_origin, 'polymarket') AS signal_origin,
      CASE
        WHEN confidence < 60 THEN '50-60'
        WHEN confidence < 70 THEN '60-70'
        WHEN confidence < 80 THEN '70-80'
        ELSE '80+'
      END AS band,
      COUNT(*) AS n,
      SUM(CASE WHEN tp_first = 1 THEN 1 ELSE 0 END) AS tp_count,
      AVG(max_favorable_pct) AS mean_mfe,
      AVG(max_adverse_pct) AS mean_mae,
      AVG(net_max_favorable_pct) AS mean_net_mfe
    FROM push_outcomes
    WHERE COALESCE(is_shadow, 0) = 1
      AND evaluated_at IS NOT NULL
    GROUP BY 1, 2
    ORDER BY signal_origin, band
  `).all().map(row => {
    const n = Number(row.n || 0);
    const tpCount = Number(row.tp_count || 0);
    const tpRate = n > 0 ? tpCount / n : 0;
    const wilson95lb = wilsonLowerBound(tpCount, n);
    const meanNetMfe = row.mean_net_mfe == null ? null : Number(row.mean_net_mfe);
    const decision =
      n >= 20 && wilson95lb >= 0.45 && (meanNetMfe ?? Number.NEGATIVE_INFINITY) > 0 ? 'RE_ENABLE'
        : n >= 10 && wilson95lb >= 0.40 ? 'PARTIAL'
          : 'FAIL';
    return {
      signal_origin: row.signal_origin,
      band: row.band,
      n,
      tp_count: tpCount,
      tp_rate: tpRate,
      wilson_95_lb: wilson95lb,
      mean_mfe: row.mean_mfe == null ? null : Number(row.mean_mfe),
      mean_mae: row.mean_mae == null ? null : Number(row.mean_mae),
      mean_net_mfe: meanNetMfe,
      decision
    };
  });

  const bypassRows = db.prepare(`
    SELECT shadow_bypassed_gates
    FROM push_outcomes
    WHERE COALESCE(is_shadow, 0) = 1
      AND shadow_push_at >= datetime('now', '-7 days')
      AND shadow_bypassed_gates IS NOT NULL
  `).all();
  const bypassCounts = new Map();
  for (const row of bypassRows) {
    for (const gate of parseMaybeJsonArray(row.shadow_bypassed_gates)) {
      const key = String(gate);
      bypassCounts.set(key, (bypassCounts.get(key) || 0) + 1);
    }
  }
  const topBypassedGates = Array.from(bypassCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const topAssets = db.prepare(`
    SELECT
      asset_id,
      COUNT(*) AS n
    FROM push_outcomes
    WHERE COALESCE(is_shadow, 0) = 1
    GROUP BY asset_id
    ORDER BY n DESC, asset_id
    LIMIT 10
  `).all();

  return {
    firstShadowPushAt: firstShadow?.first_shadow_push_at || null,
    funnel,
    slices,
    topBypassedGates,
    topAssets
  };
}

function renderSliceRow(row, includeDecision = false) {
  const parts = [
    row.signal_origin.padEnd(22),
    row.band.padEnd(5),
    String(row.n).padStart(3),
    String(row.tp_count).padStart(3),
    formatPct(row.tp_rate, 1).padStart(7),
    formatPct(row.wilson_95_lb, 1).padStart(8),
    formatNumber(row.mean_mfe, 2).padStart(8),
    formatNumber(row.mean_mae, 2).padStart(8),
    formatNumber(row.mean_net_mfe, 2).padStart(9)
  ];
  if (includeDecision) {
    parts.push(String(row.decision).padStart(10));
  } else if (row.decision === 'RE_ENABLE') {
    parts.push('  <- validated');
  }
  return parts.join(' | ');
}

function printDecisionOnly(report) {
  console.log('origin'.padEnd(22) + ' | band  |   n | tp | tp_rate | wilson_lb | mean_mfe | mean_mae | net_mfe |   DECISION');
  console.log('-'.repeat(112));
  if (report.slices.length === 0) {
    console.log('no shadow outcomes evaluated yet');
    return;
  }
  for (const row of report.slices) {
    console.log(renderSliceRow(row, true));
  }
}

function printFullReport(report) {
  const heartbeat = getHeartbeatAge();
  const logStats = getScanLogStats();

  console.log('=== SHADOW REPORT ===');
  console.log(`generated_at_utc: ${new Date().toISOString()}`);
  console.log(`db_path: ${DB_PATH}`);
  console.log(
    `shadow_start: ${report.firstShadowPushAt || 'n/a'} | trading_days_since_start: ${countTradingDaysSince(report.firstShadowPushAt)}`
  );
  console.log('');
  console.log('[Funnel last 7 days]');
  console.log(`signals_generated: ${report.funnel.signals_generated || 0}`);
  console.log(`signals_reaching_shadow_gate: ${report.funnel.signals_reaching_shadow_gate || 0}`);
  console.log(`shadow_rows_created: ${report.funnel.shadow_rows_created || 0}`);
  console.log(`shadow_rows_evaluated: ${report.funnel.shadow_rows_evaluated || 0}`);
  console.log(`pending_shadow_over_24h: ${report.funnel.pending_shadow_over_24h || 0}`);
  console.log('');
  console.log('[Evaluated shadow slices]');
  console.log('origin'.padEnd(22) + ' | band  |   n | tp | tp_rate | wilson_lb | mean_mfe | mean_mae | net_mfe');
  console.log('-'.repeat(100));
  if (report.slices.length === 0) {
    console.log('no shadow outcomes evaluated yet');
  } else {
    for (const row of report.slices) {
      console.log(renderSliceRow(row));
    }
  }
  console.log('');
  console.log('[Top bypassed gates, 7d]');
  if (report.topBypassedGates.length === 0) {
    console.log('none');
  } else {
    for (const [gate, count] of report.topBypassedGates) {
      console.log(`${gate}: ${count}`);
    }
  }
  console.log('');
  console.log('[Top shadow assets]');
  if (report.topAssets.length === 0) {
    console.log('none');
  } else {
    for (const row of report.topAssets) {
      console.log(`${row.asset_id}: ${row.n}`);
    }
  }
  console.log('');
  console.log('[Operational]');
  console.log(`heartbeat: ${heartbeat.raw}`);
  console.log(`heartbeat_age_minutes: ${heartbeat.ageMinutes ?? 'n/a'}`);
  console.log(`last_cycle: ${logStats.lastCycle ?? 'n/a'}`);
  console.log(`recent_timeouts: ${logStats.timeoutCount}`);
  for (const sample of logStats.timeoutSample) {
    console.log(`timeout_sample: ${sample}`);
  }
}

function main() {
  const decisionOnly = process.argv.includes('--decision');
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const report = loadReport(db);
    if (decisionOnly) {
      printDecisionOnly(report);
    } else {
      printFullReport(report);
    }
  } finally {
    db.close();
  }
}

main();
