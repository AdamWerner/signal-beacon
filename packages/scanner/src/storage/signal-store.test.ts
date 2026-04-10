import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { InsertSignal, SignalStore } from './signal-store.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE signals (
      id TEXT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      signal_origin TEXT,
      market_condition_id TEXT,
      market_slug TEXT,
      market_title TEXT,
      odds_before REAL,
      odds_now REAL,
      delta_pct REAL,
      time_window_minutes INTEGER,
      whale_detected INTEGER,
      whale_amount_usd REAL,
      matched_asset_id TEXT,
      matched_asset_name TEXT,
      polarity TEXT,
      suggested_action TEXT,
      suggested_instruments TEXT,
      reasoning TEXT,
      confidence INTEGER,
      requires_judgment INTEGER,
      deduplication_key TEXT,
      verification_status TEXT,
      verification_score INTEGER,
      verification_reason TEXT,
      verification_flags TEXT,
      verification_source TEXT,
      verification_record TEXT,
      verification_updated_at TEXT,
      confirming_source_families TEXT,
      source_count_override INTEGER
    );
  `);
  return db;
}

function buildSignal(id: string, marketConditionId: string): InsertSignal {
  return {
    id,
    signal_origin: 'polymarket',
    market_condition_id: marketConditionId,
    market_slug: `slug-${marketConditionId}`,
    market_title: `Market ${marketConditionId}`,
    odds_before: 0.4,
    odds_now: 0.6,
    delta_pct: 50,
    time_window_minutes: 30,
    whale_detected: false,
    whale_amount_usd: null,
    matched_asset_id: 'oil-equinor',
    matched_asset_name: 'Equinor',
    polarity: 'direct',
    suggested_action: 'BULL Equinor',
    suggested_instruments: [],
    reasoning: 'test reasoning',
    confidence: 70,
    requires_judgment: false,
    deduplication_key: `${marketConditionId}:oil-equinor`,
    verification_status: 'approved',
    verification_score: 80,
    verification_reason: 'ok',
    verification_flags: [],
    verification_source: 'test',
    verification_record: null,
    confirming_source_families: ['news'],
    source_count_override: 1
  };
}

describe('SignalStore.replaceInTransaction', () => {
  const openDbs: Database.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  it('rolls back the delete if replacement insert fails', () => {
    const db = createDb();
    openDbs.push(db);
    const store = new SignalStore(db);

    const original = buildSignal('signal-old', 'market-old');
    const conflicting = buildSignal('signal-conflict', 'market-conflict');
    store.insert(original);
    store.insert(conflicting);

    const replacement = buildSignal('signal-conflict', 'market-new');

    expect(() => store.replaceInTransaction(original.id, replacement)).toThrow();

    const rows = db.prepare('SELECT id FROM signals ORDER BY id').all() as Array<{ id: string }>;
    expect(rows.map(row => row.id)).toEqual(['signal-conflict', 'signal-old']);
    expect(store.findById(original.id)?.market_condition_id).toBe('market-old');
  });
});
