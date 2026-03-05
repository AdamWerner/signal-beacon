import Database from 'better-sqlite3';

export interface TweetAccount {
  id: number;
  handle: string;
  display_name: string | null;
  category: 'macro' | 'energy' | 'defense' | 'tech' | 'swedish' | 'crypto';
  weight: number;
  is_active: boolean;
  last_scraped_at: string | null;
  scrape_failures: number;
}

export interface TweetSnapshot {
  id: number;
  account_handle: string;
  tweet_id: string | null;
  tweet_text: string;
  tweet_url: string | null;
  posted_at: string | null;
  scraped_at: string;
  likes: number;
  retweets: number;
  replies: number;
  matched_asset_ids: string | null;
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'mixed' | null;
  ai_processed: boolean;
}

export interface UnprocessedTweet extends TweetSnapshot {
  category: TweetAccount['category'];
  weight: number;
}

export interface InsertTweet {
  account_handle: string;
  tweet_id?: string;
  tweet_text: string;
  tweet_url?: string;
  posted_at?: string;
  likes?: number;
  retweets?: number;
  replies?: number;
}

export const DEFAULT_TWEET_ACCOUNTS: Array<{
  handle: string;
  display_name: string;
  category: TweetAccount['category'];
  weight: number;
}> = [
  // Macro
  { handle: 'NickTimiraos', display_name: 'Nick Timiraos', category: 'macro', weight: 2.5 },
  { handle: 'DeItaone', display_name: 'Walter Bloomberg', category: 'macro', weight: 2.4 },
  { handle: 'FirstSquawk', display_name: 'First Squawk', category: 'macro', weight: 2.0 },
  { handle: 'markets', display_name: 'Bloomberg Markets', category: 'macro', weight: 2.0 },
  { handle: 'ReutersBiz', display_name: 'Reuters Business', category: 'macro', weight: 2.0 },
  { handle: 'financialjuice', display_name: 'FinancialJuice', category: 'macro', weight: 1.6 },
  { handle: 'ForexLive', display_name: 'ForexLive', category: 'macro', weight: 1.5 },
  { handle: 'unusual_whales', display_name: 'Unusual Whales', category: 'macro', weight: 1.8 },

  // Energy
  { handle: 'JavierBlas', display_name: 'Javier Blas', category: 'energy', weight: 2.5 },
  { handle: 'Amaborst', display_name: 'Amena Bakr', category: 'energy', weight: 2.0 },
  { handle: 'DavidSheppard4', display_name: 'David Sheppard', category: 'energy', weight: 1.8 },

  // Defense
  { handle: 'RALee85', display_name: 'Rob Lee', category: 'defense', weight: 1.7 },
  { handle: 'sentdefender', display_name: 'SentDefender', category: 'defense', weight: 1.6 },
  { handle: 'IntelCrab', display_name: 'IntelCrab', category: 'defense', weight: 1.4 },
  { handle: 'Faytuks', display_name: 'Faytuks News', category: 'defense', weight: 1.2 },

  // Tech
  { handle: 'sama', display_name: 'Sam Altman', category: 'tech', weight: 2.1 },
  { handle: 'elonmusk', display_name: 'Elon Musk', category: 'tech', weight: 2.3 },
  { handle: 'JensenHuang', display_name: 'Jensen Huang', category: 'tech', weight: 2.0 },
  { handle: 'StockMKTNewz', display_name: 'StockMKTNewz', category: 'tech', weight: 1.1 },

  // Swedish
  { handle: 'avaborsen', display_name: 'Avanza Borsen', category: 'swedish', weight: 1.7 },
  { handle: 'nordaborsen', display_name: 'Nordnet Borsen', category: 'swedish', weight: 1.6 },
  { handle: 'didigital', display_name: 'DI Digital', category: 'swedish', weight: 1.4 },
  { handle: 'Placera', display_name: 'Placera', category: 'swedish', weight: 1.2 },
  { handle: 'Affarsvarlden', display_name: 'Affarsvarlden', category: 'swedish', weight: 1.2 },

  // Crypto
  { handle: 'WatcherGuru', display_name: 'Watcher Guru', category: 'crypto', weight: 1.0 },
  { handle: 'whale_alert', display_name: 'Whale Alert', category: 'crypto', weight: 1.0 }
];

export class TweetStore {
  constructor(private db: Database.Database) {}

  /**
   * Seed default accounts if table is empty.
   */
  seedDefaultAccounts(): number {
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM tweet_accounts').get() as { c: number }).c;
    if (count > 0) return 0;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO tweet_accounts (handle, display_name, category, weight)
      VALUES (?, ?, ?, ?)
    `);

    let inserted = 0;
    for (const account of DEFAULT_TWEET_ACCOUNTS) {
      stmt.run(account.handle, account.display_name, account.category, account.weight);
      inserted += 1;
    }

    return inserted;
  }

  getActiveAccounts(): TweetAccount[] {
    return this.db.prepare(
      'SELECT * FROM tweet_accounts WHERE is_active = TRUE ORDER BY weight DESC'
    ).all() as TweetAccount[];
  }

  insertTweet(tweet: InsertTweet): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO tweet_snapshots (
        account_handle, tweet_id, tweet_text, tweet_url, posted_at,
        likes, retweets, replies
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tweet.account_handle,
      tweet.tweet_id || null,
      tweet.tweet_text,
      tweet.tweet_url || null,
      tweet.posted_at || null,
      tweet.likes || 0,
      tweet.retweets || 0,
      tweet.replies || 0
    );
  }

  markAccountScraped(handle: string): void {
    this.db.prepare(
      `UPDATE tweet_accounts SET last_scraped_at = datetime('now'), scrape_failures = 0 WHERE handle = ?`
    ).run(handle);
  }

  markAccountFailed(handle: string): void {
    this.db.prepare(
      `UPDATE tweet_accounts SET scrape_failures = scrape_failures + 1 WHERE handle = ?`
    ).run(handle);
  }

  /**
   * Get recent unprocessed tweets for batch AI analysis.
   */
  getUnprocessedTweets(limit = 200): UnprocessedTweet[] {
    return this.db.prepare(`
      SELECT ts.*, ta.category, ta.weight
      FROM tweet_snapshots ts
      JOIN tweet_accounts ta ON ta.handle = ts.account_handle
      WHERE ts.ai_processed = FALSE
        AND ts.scraped_at >= datetime('now', '-24 hours')
      ORDER BY ta.weight DESC, ts.scraped_at DESC
      LIMIT ?
    `).all(limit) as UnprocessedTweet[];
  }

  getRecentByCategory(category: TweetAccount['category'], hours = 24): TweetSnapshot[] {
    return this.db.prepare(`
      SELECT ts.*
      FROM tweet_snapshots ts
      JOIN tweet_accounts ta ON ta.handle = ts.account_handle
      WHERE ta.category = ?
        AND ts.scraped_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY ts.scraped_at DESC
      LIMIT 50
    `).all(category, hours) as TweetSnapshot[];
  }

  markProcessed(tweetIds: number[], matchedAssets?: string, sentiment?: TweetSnapshot['sentiment']): void {
    const stmt = this.db.prepare(`
      UPDATE tweet_snapshots
      SET ai_processed = TRUE, matched_asset_ids = ?, sentiment = ?
      WHERE id = ?
    `);

    for (const id of tweetIds) {
      stmt.run(matchedAssets || null, sentiment || null, id);
    }
  }

  getTweetIntelligenceSummary(hours = 16): {
    total: number;
    byCategory: Record<string, number>;
    bySentiment: Record<string, number>;
    topAccountActivity: Array<{ handle: string; count: number; weight: number }>;
  } {
    const total = (this.db.prepare(`
      SELECT COUNT(*) as c FROM tweet_snapshots
      WHERE scraped_at >= datetime('now', '-' || ? || ' hours')
    `).get(hours) as { c: number }).c;

    const byCategory = Object.fromEntries(
      (this.db.prepare(`
        SELECT ta.category, COUNT(*) as c
        FROM tweet_snapshots ts
        JOIN tweet_accounts ta ON ta.handle = ts.account_handle
        WHERE ts.scraped_at >= datetime('now', '-' || ? || ' hours')
        GROUP BY ta.category
      `).all(hours) as Array<{ category: string; c: number }>).map(row => [row.category, row.c])
    );

    const bySentiment = Object.fromEntries(
      (this.db.prepare(`
        SELECT sentiment, COUNT(*) as c
        FROM tweet_snapshots
        WHERE scraped_at >= datetime('now', '-' || ? || ' hours')
          AND sentiment IS NOT NULL
        GROUP BY sentiment
      `).all(hours) as Array<{ sentiment: string; c: number }>).map(row => [row.sentiment, row.c])
    );

    const topAccountActivity = this.db.prepare(`
      SELECT ts.account_handle as handle, COUNT(*) as count, ta.weight
      FROM tweet_snapshots ts
      JOIN tweet_accounts ta ON ta.handle = ts.account_handle
      WHERE ts.scraped_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY ts.account_handle
      ORDER BY ta.weight * COUNT(*) DESC
      LIMIT 10
    `).all(hours) as Array<{ handle: string; count: number; weight: number }>;

    return { total, byCategory, bySentiment, topAccountActivity };
  }

  cleanupOld(daysToKeep: number): number {
    return this.db.prepare(
      `DELETE FROM tweet_snapshots WHERE scraped_at < datetime('now', '-' || ? || ' days')`
    ).run(daysToKeep).changes;
  }
}
