#!/usr/bin/env node

import 'dotenv/config';

process.env.DRY_RUN = 'true';

function toSqliteTimestamp(date) {
  return new Date(date.getTime() - 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function summarizeCounts(rows, keyFn, extraFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const current = map.get(key) || { key, count: 0 };
    current.count += 1;
    if (extraFn) {
      extraFn(current, row);
    }
    map.set(key, current);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

console.log('Running controlled DRY_RUN scan audit...\n');

const { scanner } = await import('@polysignal/scanner');
const services = scanner.getServices();
const db = services.db;
const beforeRow = db.prepare(`SELECT IFNULL(MAX(rowid), 0) as maxRowId FROM signals`).get();

try {
  const result = await scanner.runScanCycle();
  const rows = db.prepare(`
    SELECT rowid, id, timestamp, matched_asset_id, matched_asset_name, market_title,
           confidence, verification_status, primary_source_family,
           execution_replay_gate, reasoning
    FROM signals
    WHERE rowid > ?
    ORDER BY confidence DESC, timestamp DESC
  `).all(beforeRow.maxRowId || 0);

  const byAsset = summarizeCounts(
    rows,
    row => `${row.matched_asset_name} (${row.matched_asset_id})`,
    (entry, row) => {
      entry.maxConfidence = Math.max(entry.maxConfidence ?? 0, Number(row.confidence || 0));
      entry.families = entry.families || new Set();
      if (row.primary_source_family) entry.families.add(row.primary_source_family);
    }
  ).slice(0, 10).map(entry => ({
    asset: entry.key,
    count: entry.count,
    maxConfidence: entry.maxConfidence ?? 0,
    families: Array.from(entry.families || [])
  }));

  const byFamily = summarizeCounts(
    rows.filter(row => row.primary_source_family),
    row => row.primary_source_family
  ).slice(0, 10);

  const byCluster = summarizeCounts(
    rows,
    row => `${row.matched_asset_id} :: ${String(row.market_title).slice(0, 80)}`
  ).slice(0, 12);

  const proxyTagged = rows.filter(row => String(row.reasoning || '').includes('[proxy:')).length;
  const replayBlocked = rows.filter(row => row.execution_replay_gate === 'block').length;
  const approved = rows.filter(row => row.verification_status === 'approved').length;

  const summary = {
    cycle: {
      marketsTracked: result.marketsTracked,
      oddsChangesDetected: result.oddsChangesDetected,
      whalesDetected: result.whalesDetected,
      signalsGenerated: result.signalsGenerated,
      haPushed: result.haPushed,
      brewed: result.brewed,
      durationSeconds: Number((result.duration / 1000).toFixed(1))
    },
    aggregation: {
      rowsCaptured: rows.length,
      approved,
      proxyTagged,
      replayBlocked,
      byAsset,
      byFamily,
      byCluster
    }
  };

  console.log(JSON.stringify(summary, null, 2));
  scanner.shutdown?.();
  process.exit(0);
} catch (error) {
  console.error('Controlled scan audit failed:', error);
  scanner.shutdown?.();
  process.exit(1);
}
