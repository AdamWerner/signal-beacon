import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { NewsCorrelator } from './news-correlator.js';

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
