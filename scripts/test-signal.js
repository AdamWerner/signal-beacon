#!/usr/bin/env node
/**
 * Weekly live-push canary.
 *
 * Run manually from the scanner host once per week:
 *   node scripts/test-signal.js --confirm
 *   npm run canary:push -- --confirm
 *
 * This confirms the full live push chain:
 * dispatcher -> Home Assistant -> phone.
 * Without it, "no qualifying signal" and "broken push pipeline" are
 * indistinguishable during quiet sessions.
 *
 * The synthetic signal reuses a real tracked market condition_id/slug for
 * foreign-key integrity. It is tagged with signal_origin='canary' so
 * downstream analytics and push-outcome tracking exclude it from real stats.
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';

const CONFIRM_FLAG = '--confirm';
const CLEANUP_DELAY_MS = 5 * 60 * 1000;
const EXPECTED_OUTCOME = 'pushed: all gates passed';
const TARGET_ASSET_ID = 'oil-equinor';

function usage(exitCode = 1) {
  console.log('Usage: node scripts/test-signal.js --confirm');
  console.log('Sends one real weekly live-push canary through the live dispatcher.');
  process.exit(exitCode);
}

function findCanaryMarket(db) {
  const preferred = db.prepare(`
    SELECT condition_id, slug, title
    FROM tracked_markets
    WHERE is_active = TRUE
      AND matched_asset_ids LIKE ?
    ORDER BY COALESCE(last_checked_at, discovered_at) DESC, id DESC
    LIMIT 1
  `).get(`%${TARGET_ASSET_ID}%`);

  if (preferred) return preferred;

  return db.prepare(`
    SELECT condition_id, slug, title
    FROM tracked_markets
    WHERE is_active = TRUE
    ORDER BY COALESCE(last_checked_at, discovered_at) DESC, id DESC
    LIMIT 1
  `).get();
}

function buildSyntheticSignal(id, market) {
  return {
    id,
    signal_origin: 'canary',
    market_condition_id: market.condition_id,
    market_slug: market.slug,
    market_title: 'POLYSIGNAL LIVE-PUSH CANARY - NOT A REAL SIGNAL',
    odds_before: 0.52,
    odds_now: 0.77,
    delta_pct: 25,
    time_window_minutes: 30,
    whale_detected: true,
    whale_amount_usd: 15000,
    matched_asset_id: TARGET_ASSET_ID,
    matched_asset_name: 'Equinor',
    polarity: 'direct',
    suggested_action: 'BULL Equinor (TEST)',
    suggested_instruments: [],
    reasoning: 'Weekly live-push canary only. Verifies dispatcher -> Home Assistant -> phone. [canary:test] [execution: manual canary validation]',
    confidence: 82,
    requires_judgment: false,
    deduplication_key: `canary:${id}`,
    verification_status: 'approved',
    verification_score: 75,
    verification_reason: 'Weekly live-push canary approved for pipeline validation',
    verification_flags: [],
    verification_source: 'fallback_guard',
    verification_record: JSON.stringify({ score: 75, kind: 'weekly_canary' }),
    primary_source_family: 'canary',
    catalyst_score: 80,
    confirming_source_families: ['canary'],
    source_count_override: 1
  };
}

async function cleanupCanary(db, signalStore, signalId, outcomeText) {
  try {
    db.prepare(`
      UPDATE signals
      SET signal_origin = 'canary',
          status = 'dismissed'
      WHERE id = ?
    `).run(signalId);

    db.prepare(`
      DELETE FROM push_outcomes
      WHERE signal_id = ?
    `).run(signalId);

    signalStore.updatePushGateOutcome(signalId, `${outcomeText} [cleanup:dismissed_canary]`);
    console.log(`Canary ${signalId} flagged as dismissed and removed from push_outcomes.`);
  } catch (error) {
    console.error(`Canary cleanup failed for ${signalId}:`, error);
  }
}

if (!process.argv.includes(CONFIRM_FLAG)) {
  usage(1);
}

if (process.env.DRY_RUN === 'true') {
  console.error('Refusing to run canary with DRY_RUN=true. Unset DRY_RUN and rerun with --confirm.');
  process.exit(1);
}

process.env.AI_BUDGET_MODE_OVERRIDE = process.env.AI_BUDGET_MODE_OVERRIDE || 'dormant';

const { scanner } = await import('@polysignal/scanner');
const services = scanner.getServices();
const signalStore = services.signalStore;
const db = services.db;
const dispatcher = scanner.alertDispatcher;

if (!signalStore || !db || !dispatcher || typeof dispatcher.dispatchBatch !== 'function') {
  console.error('Live scanner services unavailable. Build the scanner and confirm Home Assistant is configured.');
  process.exit(1);
}

const signalId = `canary-${randomUUID()}`;
const market = findCanaryMarket(db);

if (!market) {
  console.error(`No active tracked markets found. Cannot run canary without a real condition_id for FK integrity.`);
  scanner.shutdown?.();
  process.exit(2);
}

const syntheticSignal = buildSyntheticSignal(signalId, market);

console.log(`Creating weekly live-push canary ${signalId} using tracked market ${market.condition_id} (${market.slug})...`);
signalStore.insert(syntheticSignal);
signalStore.updatePushGateOutcome(signalId, 'canary_pending');

let exitCode = 0;

try {
  await dispatcher.dispatchBatch([syntheticSignal]);
  const stored = signalStore.findById(signalId);
  const outcome = String(stored?.push_gate_outcome || '');
  console.log(`push_gate_outcome: ${outcome || 'missing'}`);

  if (outcome !== EXPECTED_OUTCOME) {
    console.error(`Canary push failed. Expected "${EXPECTED_OUTCOME}" but got "${outcome || 'missing'}".`);
    exitCode = 1;
    await cleanupCanary(db, signalStore, signalId, outcome || 'canary_failed');
  } else {
    console.log('Canary push passed. Waiting 5 minutes before cleanup so the notification can be observed.');
    await new Promise(resolve => setTimeout(resolve, CLEANUP_DELAY_MS));
    await cleanupCanary(db, signalStore, signalId, outcome);
  }
} catch (error) {
  console.error('Canary dispatch threw:', error);
  exitCode = 1;
  await cleanupCanary(db, signalStore, signalId, 'canary_exception');
} finally {
  scanner.shutdown?.();
}

process.exit(exitCode);
