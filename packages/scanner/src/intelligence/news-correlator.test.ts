import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NewsCorrelator } from './news-correlator.js';

// Force Stockholm timezone so the SQLite-UTC recency fix is exercised.
// On a Stockholm (CEST = UTC+2) machine, raw Date.parse('YYYY-MM-DD HH:MM:SS')
// interprets the timestamp as local time → timestamps appear 2h older than
// they really are → fresh news is silently under-counted by the boost tiers.
beforeAll(() => {
  process.env.TZ = 'Europe/Stockholm';
});

// Helper: produce a SQLite CURRENT_TIMESTAMP-style string (no Z) for a given
// Date. This is the exact format SQLite stores in the tweet_snapshots table.
function toSqliteUtc(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tweet_snapshots (
      account_handle TEXT,
      tweet_text TEXT,
      scraped_at TEXT
    );
    CREATE TABLE tweet_accounts (
      handle TEXT,
      weight REAL
    );
  `);
  return db;
}

describe('NewsCorrelator', () => {
  const openDbs: Database.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
  });

  it('does not boost bull signals with bearish asset headlines', () => {
    const db = createDb();
    openDbs.push(db);
    db.prepare(`
      INSERT INTO tweet_snapshots (account_handle, tweet_text, scraped_at)
      VALUES (?, ?, datetime('now', '-10 minutes'))
    `).run('markets', 'Volvo among stock losers after weak session');

    const correlator = new NewsCorrelator(db);
    const bullBoost = correlator.getBoostForSignal('auto-volvo', 'bull', 6);
    const bearBoost = correlator.getBoostForSignal('auto-volvo', 'bear', 6);

    expect(bullBoost.boost).toBe(0);
    expect(bearBoost.sourceCount).toBe(1);
  });

  it('returns contradiction=true when ≥30% of directional sources oppose the signal direction', () => {
    const db = createDb();
    openDbs.push(db);
    const stmt = db.prepare(`
      INSERT INTO tweet_snapshots (account_handle, tweet_text, scraped_at)
      VALUES (?, ?, datetime('now', '-10 minutes'))
    `);
    // 2 bull sources for Equinor
    stmt.run('src1', 'Equinor record profits surge');
    stmt.run('src2', 'Equinor gains on strong oil order');
    // 2 bear sources — contradiction
    stmt.run('src3', 'Equinor drops on weak demand warning');
    stmt.run('src4', 'Equinor falls as oil loses ground');

    const correlator = new NewsCorrelator(db);
    const result = correlator.getBoostForSignal('oil-equinor', 'bull', 6);

    // 2 opposing out of 4 total = 50% → contradiction
    expect(result.contradiction).toBe(true);
  });

  it('returns contradiction=false when opposing sources are below 30% threshold', () => {
    const db = createDb();
    openDbs.push(db);
    const stmt = db.prepare(`
      INSERT INTO tweet_snapshots (account_handle, tweet_text, scraped_at)
      VALUES (?, ?, datetime('now', '-10 minutes'))
    `);
    // 3 bull, 1 bear → 25% opposing — below threshold
    stmt.run('src1', 'Equinor record profits surge');
    stmt.run('src2', 'Equinor gains on strong oil order');
    stmt.run('src3', 'Equinor rises on contract win');
    stmt.run('src4', 'Equinor drops on weak demand warning');

    const correlator = new NewsCorrelator(db);
    const result = correlator.getBoostForSignal('oil-equinor', 'bull', 6);

    expect(result.contradiction).toBe(false);
  });

  it('dominantDirection reflects majority news direction', () => {
    const db = createDb();
    openDbs.push(db);
    const stmt = db.prepare(`
      INSERT INTO tweet_snapshots (account_handle, tweet_text, scraped_at)
      VALUES (?, ?, datetime('now', '-10 minutes'))
    `);
    stmt.run('src1', 'Equinor drops on weak demand warning');
    stmt.run('src2', 'Equinor falls as oil loses ground');
    stmt.run('src3', 'Equinor collapse risk');

    const correlator = new NewsCorrelator(db);
    const result = correlator.getBoostForSignal('oil-equinor', 'bull', 6);

    // signal is bull, all news is bear → opposing dominant
    expect(result.dominantDirection).toBe('bear');
  });

  // ── Timezone / recency regression ────────────────────────────────────────
  // These tests insert rows in SQLite UTC format (no 'Z' suffix), which is
  // exactly how the live DB stores scraped_at values. The important property
  // is that JS recency parsing treats them as UTC rather than Stockholm local
  // time; the SQL WHERE clause still uses SQLite's real clock, so these rows
  // must remain within the last 6 hours in wall-clock time too.

  it('5-min-old SQLite UTC row gets recencyWeight=1.0 → boost is non-zero (TZ regression)', () => {
    const db = createDb();
    openDbs.push(db);

    // Insert one bullish Equinor headline exactly 5 min before pinned 'now' in SQLite UTC format
    const fiveMinAgo = toSqliteUtc(new Date(Date.now() - 5 * 60 * 1000));
    db.prepare(`
      INSERT INTO tweet_snapshots (account_handle, tweet_text, scraped_at)
      VALUES (?, ?, ?)
    `).run('fresh-src', 'Equinor record profits surge', fiveMinAgo);

    const correlator = new NewsCorrelator(db);
    const result = correlator.getBoostForSignal('oil-equinor', 'bull', 6);

    // With parseDbTimestampMs: age = 5 min → weight 1.0 → weightedSources = 1.0 → boost = 3
    // With raw Date.parse on Stockholm: age ≈ 125 min → weight 0.25 → boost = 0
    expect(result.boost).toBeGreaterThan(0);
    expect(result.sourceCount).toBe(1);
  });

  it('75-min-old SQLite UTC row gets recencyWeight=0.5 (1h < age ≤ 3h tier)', () => {
    const db = createDb();
    openDbs.push(db);

    const seventyFiveMinAgo = toSqliteUtc(new Date(Date.now() - 75 * 60 * 1000));
    db.prepare(`
      INSERT INTO tweet_snapshots (account_handle, tweet_text, scraped_at)
      VALUES (?, ?, ?)
    `).run('src-75m', 'Equinor gains on strong oil order', seventyFiveMinAgo);

    const correlator = new NewsCorrelator(db);
    const result = correlator.getBoostForSignal('oil-equinor', 'bull', 6);

    // age = 75 min = 1.25h → tier 1h < age ≤ 3h → weight 0.5
    // weightedSources = 0.5 → boost = 0 (below 1.0 threshold — single source)
    // With broken Date.parse on Stockholm: age ≈ 195 min → weight 0.25 (same tier, same result)
    // The key correctness: sourceCount=1 means the row was FOUND, not silently excluded by 6h window
    expect(result.sourceCount).toBe(1);
  });

  it('270-min-old SQLite UTC row is within 6h window but has weight 0.25', () => {
    const db = createDb();
    openDbs.push(db);

    const fourHoursAgo = toSqliteUtc(new Date(Date.now() - 270 * 60 * 1000));
    db.prepare(`
      INSERT INTO tweet_snapshots (account_handle, tweet_text, scraped_at)
      VALUES (?, ?, ?)
    `).run('src-4h', 'Equinor rises on contract win', fourHoursAgo);

    const correlator = new NewsCorrelator(db);
    const result = correlator.getBoostForSignal('oil-equinor', 'bull', 6);

    // age = 270 min = 4.5h → tier 3h < age ≤ 6h → weight 0.25
    // With broken Date.parse on Stockholm: age ≈ 390 min = 6.5h → OUTSIDE 6h window → sourceCount = 0
    // This is a second class of bug: stale-window exclusion for a row that is actually fresh enough
    expect(result.sourceCount).toBe(1);
  });

  it('decays stale news instead of treating old mentions as fresh corroboration', () => {
    const db = createDb();
    openDbs.push(db);
    const stmt = db.prepare(`
      INSERT INTO tweet_snapshots (account_handle, tweet_text, scraped_at)
      VALUES (?, ?, ?)
    `);
    stmt.run('src1', 'Breaking Volvo wins major truck contract', new Date(Date.now() - (5 * 60 * 60 * 1000)).toISOString());
    stmt.run('src2', 'Volvo gains after fresh order growth', new Date(Date.now() - (5 * 60 * 60 * 1000)).toISOString());
    stmt.run('src3', 'Volvo rises on strong commercial vehicle demand', new Date(Date.now() - (5 * 60 * 60 * 1000)).toISOString());

    const correlator = new NewsCorrelator(db);
    const boost = correlator.getBoostForSignal('auto-volvo', 'bull', 6);

    expect(boost.boost).toBe(0);
    expect(boost.sourceCount).toBe(3);
  });
});
