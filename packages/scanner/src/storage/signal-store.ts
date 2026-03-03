import Database from 'better-sqlite3';

export interface Signal {
  id: string;
  timestamp: string;
  market_condition_id: string;
  market_slug: string;
  market_title: string;
  odds_before: number;
  odds_now: number;
  delta_pct: number;
  time_window_minutes: number;
  whale_detected: boolean;
  whale_amount_usd: number | null;
  matched_asset_id: string;
  matched_asset_name: string;
  polarity: 'direct' | 'inverse' | 'context_dependent';
  suggested_action: string;
  suggested_instruments: string; // JSON array as string
  reasoning: string;
  confidence: number;
  requires_judgment: boolean;
  deduplication_key: string | null;
  status: 'new' | 'viewed' | 'dismissed' | 'acted';
}

export interface InsertSignal {
  id: string;
  market_condition_id: string;
  market_slug: string;
  market_title: string;
  odds_before: number;
  odds_now: number;
  delta_pct: number;
  time_window_minutes: number;
  whale_detected: boolean;
  whale_amount_usd: number | null;
  matched_asset_id: string;
  matched_asset_name: string;
  polarity: 'direct' | 'inverse' | 'context_dependent';
  suggested_action: string;
  suggested_instruments: Array<{
    name: string;
    avanza_id: string;
    leverage: number | null;
    avanza_url: string;
  }>;
  reasoning: string;
  confidence: number;
  requires_judgment: boolean;
  deduplication_key: string;
}

export class SignalStore {
  constructor(private db: Database.Database) {}

  insert(signal: InsertSignal): void {
    const stmt = this.db.prepare(`
      INSERT INTO signals (
        id, market_condition_id, market_slug, market_title,
        odds_before, odds_now, delta_pct, time_window_minutes,
        whale_detected, whale_amount_usd, matched_asset_id, matched_asset_name,
        polarity, suggested_action, suggested_instruments, reasoning, confidence,
        requires_judgment, deduplication_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      signal.id,
      signal.market_condition_id,
      signal.market_slug,
      signal.market_title,
      signal.odds_before,
      signal.odds_now,
      signal.delta_pct,
      signal.time_window_minutes,
      signal.whale_detected ? 1 : 0,
      signal.whale_amount_usd,
      signal.matched_asset_id,
      signal.matched_asset_name,
      signal.polarity,
      signal.suggested_action,
      JSON.stringify(signal.suggested_instruments),
      signal.reasoning,
      signal.confidence,
      signal.requires_judgment ? 1 : 0,
      signal.deduplication_key
    );
  }

  findById(id: string): Signal | undefined {
    const stmt = this.db.prepare('SELECT * FROM signals WHERE id = ?');
    return stmt.get(id) as Signal | undefined;
  }

  findAll(limit = 100, status?: Signal['status']): Signal[] {
    const stmt = status
      ? this.db.prepare('SELECT * FROM signals WHERE status = ? ORDER BY timestamp DESC LIMIT ?')
      : this.db.prepare('SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?');

    return status ? stmt.all(status, limit) as Signal[] : stmt.all(limit) as Signal[];
  }

  findByMarket(market_condition_id: string): Signal[] {
    const stmt = this.db.prepare(`
      SELECT * FROM signals
      WHERE market_condition_id = ?
      ORDER BY timestamp DESC
    `);

    return stmt.all(market_condition_id) as Signal[];
  }

  /**
   * Find the most recent signal with a given deduplication key within N hours.
   * Used to prevent duplicate signals for the same market+asset combination.
   */
  findRecentByDeduplicationKey(key: string, hours: number): Signal | null {
    const stmt = this.db.prepare(`
      SELECT * FROM signals
      WHERE deduplication_key = ?
        AND timestamp >= datetime('now', '-' || ? || ' hours')
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    return (stmt.get(key, hours) as Signal) ?? null;
  }

  updateStatus(id: string, status: Signal['status']): void {
    const stmt = this.db.prepare('UPDATE signals SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }

  getStats() {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new,
        SUM(CASE WHEN status = 'viewed' THEN 1 ELSE 0 END) as viewed,
        SUM(CASE WHEN status = 'acted' THEN 1 ELSE 0 END) as acted,
        AVG(confidence) as avg_confidence
      FROM signals
    `);

    return stmt.get() as {
      total: number;
      new: number;
      viewed: number;
      acted: number;
      avg_confidence: number;
    };
  }

  cleanupOld(daysToKeep: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM signals
      WHERE timestamp < datetime('now', '-' || ? || ' days')
        AND status != 'acted'
    `);

    const info = stmt.run(daysToKeep);
    return info.changes;
  }
}
