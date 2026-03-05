import Database from 'better-sqlite3';

export interface WhaleEvent {
  id: number;
  market_condition_id: string;
  market_title?: string | null;
  timestamp: string;
  side: 'YES' | 'NO';
  size_usd: number;
  price_at_trade: number | null;
  odds_impact: number | null;
  trade_id: string | null;
}

export interface InsertWhaleEvent {
  market_condition_id: string;
  timestamp: string;
  side: 'YES' | 'NO';
  size_usd: number;
  price_at_trade: number | null;
  odds_impact: number | null;
  trade_id: string | null;
}

export class WhaleStore {
  constructor(private db: Database.Database) {}

  /**
   * Check if a whale event with this trade_id already exists (deduplication).
   */
  existsByTradeId(tradeId: string): boolean {
    const stmt = this.db.prepare(`SELECT 1 FROM whale_events WHERE trade_id = ? LIMIT 1`);
    return stmt.get(tradeId) != null;
  }

  insert(whale: InsertWhaleEvent): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO whale_events (
        market_condition_id, timestamp, side, size_usd, price_at_trade, odds_impact, trade_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      whale.market_condition_id,
      whale.timestamp,
      whale.side,
      whale.size_usd,
      whale.price_at_trade,
      whale.odds_impact,
      whale.trade_id
    );
  }

  findByMarket(market_condition_id: string, limit = 50): WhaleEvent[] {
    const stmt = this.db.prepare(`
      WITH deduped AS (
        SELECT
          w.*,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(
              w.trade_id,
              w.market_condition_id || '|' || w.timestamp || '|' || w.side || '|' || ROUND(w.size_usd, 2) || '|' || COALESCE(ROUND(w.price_at_trade, 4), 0)
            )
            ORDER BY w.id DESC
          ) as rn
        FROM whale_events w
        WHERE w.market_condition_id = ?
      )
      SELECT d.id, d.market_condition_id, d.timestamp, d.side,
             d.size_usd, d.price_at_trade, d.odds_impact, d.trade_id,
             tm.title as market_title
      FROM deduped d
      LEFT JOIN (SELECT condition_id, title FROM tracked_markets GROUP BY condition_id) tm
        ON tm.condition_id = d.market_condition_id
      WHERE d.rn = 1
      ORDER BY d.timestamp DESC
      LIMIT ?
    `);

    return stmt.all(market_condition_id, limit) as WhaleEvent[];
  }

  findRecent(hours = 24, limit = 100): WhaleEvent[] {
    const stmt = this.db.prepare(`
      WITH deduped AS (
        SELECT
          w.*,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(
              w.trade_id,
              w.market_condition_id || '|' || w.timestamp || '|' || w.side || '|' || ROUND(w.size_usd, 2) || '|' || COALESCE(ROUND(w.price_at_trade, 4), 0)
            )
            ORDER BY w.id DESC
          ) as rn
        FROM whale_events w
        WHERE w.timestamp >= datetime('now', '-' || ? || ' hours')
      )
      SELECT d.id, d.market_condition_id, d.timestamp, d.side,
             d.size_usd, d.price_at_trade, d.odds_impact, d.trade_id,
             tm.title as market_title
      FROM deduped d
      LEFT JOIN (SELECT condition_id, title FROM tracked_markets GROUP BY condition_id) tm
        ON tm.condition_id = d.market_condition_id
      WHERE d.rn = 1
      ORDER BY d.size_usd DESC
      LIMIT ?
    `);

    return stmt.all(hours, limit) as WhaleEvent[];
  }

  getRecentByMarket(market_condition_id: string, minutes = 60): WhaleEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM whale_events
      WHERE market_condition_id = ?
        AND timestamp >= datetime('now', '-' || ? || ' minutes')
      ORDER BY timestamp DESC
    `);

    return stmt.all(market_condition_id, minutes) as WhaleEvent[];
  }

  cleanupOld(daysToKeep: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM whale_events
      WHERE timestamp < datetime('now', '-' || ? || ' days')
    `);

    const info = stmt.run(daysToKeep);
    return info.changes;
  }

  /** Remove whale events for markets that no longer exist in tracked_markets */
  cleanupOrphans(): number {
    const stmt = this.db.prepare(`
      DELETE FROM whale_events
      WHERE market_condition_id NOT IN (SELECT condition_id FROM tracked_markets)
    `);
    return stmt.run().changes;
  }
}
