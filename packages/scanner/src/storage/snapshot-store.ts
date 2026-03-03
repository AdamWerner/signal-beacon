import Database from 'better-sqlite3';

export interface OddsSnapshot {
  id: number;
  market_condition_id: string;
  timestamp: string;
  odds_yes: number;
  odds_no: number;
  volume_24h: number | null;
}

export interface InsertSnapshot {
  market_condition_id: string;
  odds_yes: number;
  odds_no: number;
  volume_24h: number | null;
}

export class SnapshotStore {
  constructor(private db: Database.Database) {}

  insert(snapshot: InsertSnapshot): void {
    const stmt = this.db.prepare(`
      INSERT INTO odds_snapshots (market_condition_id, odds_yes, odds_no, volume_24h)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(
      snapshot.market_condition_id,
      snapshot.odds_yes,
      snapshot.odds_no,
      snapshot.volume_24h
    );
  }

  getLatest(market_condition_id: string): OddsSnapshot | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM odds_snapshots
      WHERE market_condition_id = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    return stmt.get(market_condition_id) as OddsSnapshot | undefined;
  }

  getHistory(market_condition_id: string, hours = 24): OddsSnapshot[] {
    const stmt = this.db.prepare(`
      SELECT * FROM odds_snapshots
      WHERE market_condition_id = ?
        AND timestamp >= datetime('now', '-' || ? || ' hours')
      ORDER BY timestamp DESC
    `);

    return stmt.all(market_condition_id, hours) as OddsSnapshot[];
  }

  getSnapshotAt(market_condition_id: string, minutes_ago: number): OddsSnapshot | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM odds_snapshots
      WHERE market_condition_id = ?
        AND timestamp <= datetime('now', '-' || ? || ' minutes')
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    return stmt.get(market_condition_id, minutes_ago) as OddsSnapshot | undefined;
  }

  calculateDelta(
    market_condition_id: string,
    time_window_minutes: number
  ): { odds_before: number; odds_now: number; delta_pct: number } | null {
    const now = this.getLatest(market_condition_id);
    const before = this.getSnapshotAt(market_condition_id, time_window_minutes);

    if (!now || !before) {
      return null;
    }

    const delta_pct = ((now.odds_yes - before.odds_yes) / before.odds_yes) * 100;

    return {
      odds_before: before.odds_yes,
      odds_now: now.odds_yes,
      delta_pct: Math.round(delta_pct * 100) / 100 // Round to 2 decimals
    };
  }

  cleanupOld(daysToKeep: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM odds_snapshots
      WHERE timestamp < datetime('now', '-' || ? || ' days')
    `);

    const info = stmt.run(daysToKeep);
    return info.changes;
  }
}
