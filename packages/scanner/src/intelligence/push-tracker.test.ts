import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateNetMaxFavorable,
  PushOutcomeTracker,
  resolveEntryAnchor
} from './push-tracker.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE signals (
      id TEXT PRIMARY KEY,
      signal_origin TEXT,
      status TEXT DEFAULT 'new',
      push_sent_at TEXT,
      matched_asset_id TEXT,
      suggested_action TEXT,
      confidence INTEGER,
      reasoning TEXT,
      source_count_override INTEGER,
      primary_source_family TEXT
    );

    CREATE TABLE push_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT NOT NULL UNIQUE,
      asset_id TEXT NOT NULL,
      ticker TEXT,
      direction TEXT,
      push_timestamp TEXT,
      signal_origin TEXT,
      confidence INTEGER,
      source_count INTEGER DEFAULT 1,
      price_at_push REAL,
      price_at_10m REAL,
      price_at_30m REAL,
      price_at_60m REAL,
      price_at_120m REAL,
      price_at_180m REAL,
      price_at_240m REAL,
      hit_tp INTEGER DEFAULT 0,
      hit_sl INTEGER DEFAULT 0,
      tp_first INTEGER DEFAULT 0,
      max_favorable_pct REAL,
      net_max_favorable_pct REAL,
      max_adverse_pct REAL,
      time_to_peak_minutes REAL,
      directionally_accurate INTEGER DEFAULT 0,
      estimated_round_trip_cost_pct REAL,
      is_shadow INTEGER NOT NULL DEFAULT 0,
      shadow_push_at TEXT,
      shadow_bypassed_gates TEXT,
      entry_anchor TEXT,
      entry_anchor_ts TEXT,
      evaluation_notes TEXT,
      evaluated_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function buildSeries(anchorIso: string, closes: number[]): Array<{ timestampMs: number; close: number }> {
  const startMs = new Date(anchorIso).getTime();
  return closes.map((close, index) => ({
    timestampMs: startMs + (index * 10 * 60 * 1000),
    close
  }));
}

describe('calculateNetMaxFavorable', () => {
  it('subtracts round-trip execution cost from max favorable move', () => {
    expect(calculateNetMaxFavorable(4, 0.008)).toBeCloseTo(3.2, 6);
  });
});

describe('resolveEntryAnchor', () => {
  it('uses immediate entry for a shadow row during tradeable hours', () => {
    const anchor = resolveEntryAnchor('oil-equinor', '2026-04-21 10:15:00');
    expect(anchor).toEqual({
      entryAnchor: 'immediate',
      entryAnchorTs: '2026-04-21T10:15:00.000Z'
    });
  });

  it('uses the next US open for an after-hours shadow row', () => {
    const anchor = resolveEntryAnchor('ai-nvidia', '2026-04-21 23:00:00');
    expect(anchor).toEqual({
      entryAnchor: 'next_open',
      entryAnchorTs: '2026-04-22T13:30:00.000Z'
    });
  });

  it('uses Monday OMX open for a weekend Swedish shadow row', () => {
    const anchor = resolveEntryAnchor('oil-equinor', '2026-04-25 12:00:00');
    expect(anchor).toEqual({
      entryAnchor: 'next_open',
      entryAnchorTs: '2026-04-27T07:00:00.000Z'
    });
  });
});

describe('PushOutcomeTracker shadow-aware evaluation', () => {
  const openDbs: Database.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
  });

  it('preserves live-push MFE/MAE evaluation for non-shadow rows', async () => {
    const db = createDb();
    openDbs.push(db);
    db.prepare(`
      INSERT INTO signals (id, signal_origin, status, push_sent_at, matched_asset_id, suggested_action, confidence)
      VALUES ('live-1', 'polymarket', 'new', '2026-04-20 14:35:00', 'ai-nvidia', 'BULL NVIDIA', 80)
    `).run();
    db.prepare(`
      INSERT INTO push_outcomes (
        signal_id, asset_id, ticker, direction, push_timestamp, signal_origin, confidence,
        source_count, estimated_round_trip_cost_pct, is_shadow
      )
      VALUES ('live-1', 'ai-nvidia', 'NVDA', 'bull', '2026-04-20 14:35:00', 'polymarket', 80, 1, 0.01, 0)
    `).run();

    const tracker = new PushOutcomeTracker(db);
    (tracker as any).priceClient = {
      getSeries: async () => buildSeries('2026-04-20T14:35:00.000Z', [100, 101, 102, 101.5, 100.5, 99.5, 101.5])
    };

    const result = await tracker.evaluatePendingOutcomes(10);
    expect(result.created).toBe(0);
    expect(result.evaluated).toBe(1);

    const row = db.prepare(`
      SELECT entry_anchor, entry_anchor_ts, price_at_push, max_favorable_pct, net_max_favorable_pct,
             max_adverse_pct, hit_tp, hit_sl, tp_first, directionally_accurate, evaluation_notes
      FROM push_outcomes
      WHERE signal_id = 'live-1'
    `).get() as Record<string, any>;

    expect(row.entry_anchor).toBe('immediate');
    expect(row.entry_anchor_ts).toBe('2026-04-20 14:35:00.000');
    expect(row.price_at_push).toBe(100);
    expect(row.max_favorable_pct).toBeCloseTo(2, 6);
    expect(row.net_max_favorable_pct).toBeCloseTo(1, 6);
    expect(row.max_adverse_pct).toBeCloseTo(-0.5, 6);
    expect(row.hit_tp).toBe(1);
    expect(row.hit_sl).toBe(0);
    expect(row.tp_first).toBe(1);
    expect(row.directionally_accurate).toBe(1);
    expect(row.evaluation_notes).toBeNull();
  });

  it('keeps live performance queries isolated from shadow rows', () => {
    const db = createDb();
    openDbs.push(db);
    db.prepare(`
      INSERT INTO signals (id, signal_origin, status, push_sent_at, matched_asset_id, suggested_action, confidence, primary_source_family)
      VALUES
        ('live-1', 'polymarket', 'new', datetime('now'), 'oil-equinor', 'BULL Equinor', 80, 'news'),
        ('shadow-1', 'hybrid', 'new', NULL, 'oil-equinor', 'BULL Equinor', 82, 'news')
    `).run();
    db.prepare(`
      INSERT INTO push_outcomes (
        signal_id, asset_id, ticker, direction, push_timestamp, signal_origin, confidence,
        source_count, estimated_round_trip_cost_pct, is_shadow, shadow_push_at
      )
      VALUES
        ('live-1', 'oil-equinor', 'EQNR', 'bull', datetime('now'), 'polymarket', 80, 1, 0.01, 0, NULL),
        ('shadow-1', 'oil-equinor', 'EQNR', 'bull', datetime('now'), 'hybrid', 82, 2, 0.01, 1, datetime('now'))
    `).run();

    const visibleToLiveStats = db.prepare(`
      SELECT COUNT(*) AS c
      FROM push_outcomes po
      LEFT JOIN signals s
        ON s.id = po.signal_id
      WHERE push_timestamp >= datetime('now', '-7 days')
        AND COALESCE(po.is_shadow, 0) = 0
    `).get() as { c: number };

    expect(visibleToLiveStats.c).toBe(1);
  });
});
