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
