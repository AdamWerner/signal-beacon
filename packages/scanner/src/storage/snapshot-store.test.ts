import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotStore } from './snapshot-store.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_condition_id TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      odds_yes REAL NOT NULL,
      odds_no REAL NOT NULL,
      volume_24h REAL
    );
  `);
  return db;
}

// Insert a snapshot offset from SQLite's current time (seconds offset)
function insertOffset(
  db: Database.Database,
  marketId: string,
  oddsYes: number,
  offsetSeconds: number
): void {
  const sign = offsetSeconds >= 0 ? '+' : '-';
  const abs = Math.abs(offsetSeconds);
  db.prepare(`
    INSERT INTO odds_snapshots (market_condition_id, timestamp, odds_yes, odds_no, volume_24h)
    VALUES (?, datetime('now', '${sign}${abs} seconds'), ?, ?, NULL)
  `).run(marketId, oddsYes, 1 - oddsYes);
}

describe('SnapshotStore.calculateDelta', () => {
  const openDbs: Database.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  it('two snapshots exactly 30 min apart with 30-min window → valid delta', () => {
    const db = createDb();
    openDbs.push(db);
    const store = new SnapshotStore(db);

    // 'before' = 30 min ago, 'now' = just now (inserted last → highest id)
    insertOffset(db, 'm1', 0.42, -30 * 60); // 30 min ago
    insertOffset(db, 'm1', 0.55, 0);         // now

    const result = store.calculateDelta('m1', 30);
    expect(result).not.toBeNull();
    expect(result!.odds_before).toBeCloseTo(0.42);
    expect(result!.odds_now).toBeCloseTo(0.55);
    // gap should be ~30 min (we allow ±2 min for test execution time)
    expect(result!.snapshot_gap_minutes).toBeGreaterThanOrEqual(29);
    expect(result!.snapshot_gap_minutes).toBeLessThanOrEqual(31);
    // delta_pct = (0.55 - 0.42) / 0.42 * 100 ≈ 30.95
    expect(result!.delta_pct).toBeCloseTo(30.95, 0);
  });

  it('two snapshots 90 min apart with 30-min window → null (stale: 90 > 30 × 1.75 = 52.5)', () => {
    const db = createDb();
    openDbs.push(db);
    const store = new SnapshotStore(db);

    // 'before' = 90 min ago — way outside the 30-min window tolerance
    insertOffset(db, 'm2', 0.30, -90 * 60); // 90 min ago
    insertOffset(db, 'm2', 0.50, 0);          // now

    // Only one snapshot satisfies '<= now - 30min': the 90-min-ago one.
    // gap = ~90 min > 30 * 1.75 = 52.5 → reject
    const result = store.calculateDelta('m2', 30);
    expect(result).toBeNull();
  });

  it('two snapshots 3 min apart with 30-min window → null (fast-insert anomaly: 3 < 30 × 0.5 = 15)', () => {
    const db = createDb();
    openDbs.push(db);
    const store = new SnapshotStore(db);

    // Both snapshots are recent, so getSnapshotAt(30) returns the one at -3min (only one ≤ now-30min? NO)
    // Actually: '-3 min' is NOT ≤ datetime('now', '-30 minutes').
    // To trigger the fast-insert anomaly we need: before snapshot IS old enough for the window,
    // but the now snapshot is only 3 min after before.
    // before = 33 min ago, now = 30 min ago → gap = 3 min < 30 * 0.5 = 15 → null
    insertOffset(db, 'm3', 0.40, -33 * 60); // 33 min ago — satisfies 'before' window
    insertOffset(db, 'm3', 0.60, -30 * 60); // 30 min ago — this is getLatest (most recent)

    // getSnapshotAt(m3, 30) returns the row at ≤ now-30min = the 33-min-ago row
    // gap = 33min - 30min = 3 min < 30 * 0.5 = 15 → null
    const result = store.calculateDelta('m3', 30);
    expect(result).toBeNull();
  });

  it('gap within ±10% of window is accepted without null', () => {
    // 30-min window, actual gap = ~32 min (6.7% deviation → accepted)
    const db = createDb();
    openDbs.push(db);
    const store = new SnapshotStore(db);

    insertOffset(db, 'm4', 0.35, -32 * 60); // 32 min ago
    insertOffset(db, 'm4', 0.45, 0);          // now

    const result = store.calculateDelta('m4', 30);
    expect(result).not.toBeNull();
    expect(result!.snapshot_gap_minutes).toBeGreaterThanOrEqual(31);
    expect(result!.snapshot_gap_minutes).toBeLessThanOrEqual(33);
  });
});
