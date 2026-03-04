import Database from 'better-sqlite3';

export interface TrackedMarket {
  id: number;
  condition_id: string;
  gamma_id: string | null;
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  matched_asset_ids: string; // JSON array as string
  relevance_score: number;
  is_active: boolean;
  volume: number | null;
  liquidity: number | null;
  discovered_at: string;
  resolved_at: string | null;
  last_checked_at: string | null;
}

export interface InsertMarket {
  condition_id: string;
  gamma_id: string | null;
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  matched_asset_ids: string[]; // Will be JSON.stringified
  relevance_score: number;
  volume: number | null;
  liquidity: number | null;
}

export class MarketStore {
  constructor(private db: Database.Database) {}

  insert(market: InsertMarket): void {
    const stmt = this.db.prepare(`
      INSERT INTO tracked_markets (
        condition_id, gamma_id, slug, title, description, category,
        matched_asset_ids, relevance_score, volume, liquidity, last_checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(condition_id) DO UPDATE SET
        gamma_id = excluded.gamma_id,
        slug = excluded.slug,
        title = excluded.title,
        description = excluded.description,
        category = excluded.category,
        matched_asset_ids = excluded.matched_asset_ids,
        relevance_score = excluded.relevance_score,
        volume = excluded.volume,
        liquidity = excluded.liquidity,
        last_checked_at = CURRENT_TIMESTAMP
    `);

    stmt.run(
      market.condition_id,
      market.gamma_id,
      market.slug,
      market.title,
      market.description,
      market.category,
      JSON.stringify(market.matched_asset_ids),
      market.relevance_score,
      market.volume,
      market.liquidity
    );
  }

  findByConditionId(condition_id: string): TrackedMarket | undefined {
    const stmt = this.db.prepare('SELECT * FROM tracked_markets WHERE condition_id = ?');
    return stmt.get(condition_id) as TrackedMarket | undefined;
  }

  findAll(activeOnly = true): TrackedMarket[] {
    const stmt = activeOnly
      ? this.db.prepare('SELECT * FROM tracked_markets WHERE is_active = TRUE ORDER BY discovered_at DESC')
      : this.db.prepare('SELECT * FROM tracked_markets ORDER BY discovered_at DESC');

    return stmt.all() as TrackedMarket[];
  }

  findByAssetId(asset_id: string): TrackedMarket[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tracked_markets
      WHERE is_active = TRUE
        AND matched_asset_ids LIKE ?
      ORDER BY relevance_score DESC
    `);

    return stmt.all(`%"${asset_id}"%`) as TrackedMarket[];
  }

  markAsResolved(condition_id: string): void {
    const stmt = this.db.prepare(`
      UPDATE tracked_markets
      SET is_active = FALSE, resolved_at = CURRENT_TIMESTAMP
      WHERE condition_id = ?
    `);
    stmt.run(condition_id);
  }

  updateLastChecked(condition_id: string): void {
    const stmt = this.db.prepare(`
      UPDATE tracked_markets
      SET last_checked_at = CURRENT_TIMESTAMP
      WHERE condition_id = ?
    `);
    stmt.run(condition_id);
  }

  countByAsset(): Record<string, number> {
    const stmt = this.db.prepare(`
      SELECT matched_asset_ids FROM tracked_markets WHERE is_active = TRUE
    `);

    const results = stmt.all() as Array<{ matched_asset_ids: string }>;
    const counts: Record<string, number> = {};

    results.forEach(row => {
      try {
        const assetIds = JSON.parse(row.matched_asset_ids) as string[];
        assetIds.forEach(id => {
          counts[id] = (counts[id] || 0) + 1;
        });
      } catch (error) {
        console.error('Failed to parse matched_asset_ids:', error);
      }
    });

    return counts;
  }

  getStats() {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_active = TRUE THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) as resolved
      FROM tracked_markets
    `);

    return stmt.get() as { total: number; active: number; resolved: number };
  }
}
