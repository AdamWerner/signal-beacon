import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type TweetCategory = 'macro' | 'energy' | 'defense' | 'tech' | 'swedish' | 'crypto' | 'unknown';
export type TweetDiscoverySource = 'seed' | 'dataset' | 'graph' | 'manual';

export interface TweetAccount {
  id: number;
  handle: string;
  display_name: string | null;
  category: TweetCategory;
  weight: number;
  is_active: boolean;
  discovery_source: TweetDiscoverySource;
  causality_score: number;
  causal_tags: string;
  causal_thesis: string | null;
  discovery_depth: number;
  collect_enabled: boolean;
  last_scraped_at: string | null;
  last_collected_at: string | null;
  scrape_failures: number;
  feed_url: string | null;
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
  category: TweetCategory;
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

export interface UpsertTweetAccountInput {
  handle: string;
  displayName?: string;
  category: TweetCategory;
  weight: number;
  causalityScore: number;
  discoverySource: TweetDiscoverySource;
  collectEnabled?: boolean;
  discoveryDepth?: number;
  causalTags?: string[];
  causalThesis?: string;
  isActive?: boolean;
  feedUrl?: string;
}

export interface ConnectionDiscoveryResult {
  accountsAdded: number;
  connectionsAdded: number;
}

export interface UniverseExpansionResult {
  previousCount: number;
  currentCount: number;
  insertedFromSeed: number;
  discoveredFromConnections: number;
  collectionSetSize: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadNewsSources(): NewsSourceAccount[] {
  // Load from data/news-sources.json (financial RSS feeds replacing the defunct Nitter/Twitter approach)
  try {
    const seedPath = join(__dirname, '../../../../data/news-sources.json');
    const raw = readFileSync(seedPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as NewsSourceAccount[] : [];
  } catch {
    return [];
  }
}

const newsSources: NewsSourceAccount[] = loadNewsSources();

interface NewsSourceAccount {
  handle: string;
  display_name?: string;
  category?: string;
  weight?: number;
  causality_score?: number;
  discovery_source?: string;
  collect_enabled?: boolean;
  discovery_depth?: number;
  causal_tags?: string[];
  causal_thesis?: string;
  feed_url?: string;
}

const CORE_CAUSAL_ACCOUNTS: Array<{
  handle: string;
  display_name: string;
  category: TweetCategory;
  causality_score: number;
  weight: number;
  causal_tags: string[];
  causal_thesis: string;
  feed_url: string;
}> = [
  { handle: 'reuters_biz', display_name: 'Reuters Business', category: 'macro', causality_score: 0.96, weight: 2.5, causal_tags: ['macro', 'policy'], feed_url: 'https://feeds.reuters.com/reuters/businessNews', causal_thesis: 'Low-latency business headlines drive immediate market repricing.' },
  { handle: 'reuters_econ', display_name: 'Reuters Economy', category: 'macro', causality_score: 0.93, weight: 2.4, causal_tags: ['macro', 'rates'], feed_url: 'https://feeds.reuters.com/reuters/economy', causal_thesis: 'Economic data and central bank commentary directly move rate-sensitive assets.' },
  { handle: 'fed_reserve', display_name: 'Federal Reserve', category: 'macro', causality_score: 0.98, weight: 2.5, causal_tags: ['rates', 'policy'], feed_url: 'https://www.federalreserve.gov/feeds/press_all.xml', causal_thesis: 'Fed press releases set rate expectations and reprice all global risk assets.' },
  { handle: 'ecb_press', display_name: 'ECB Press Releases', category: 'macro', causality_score: 0.96, weight: 2.4, causal_tags: ['rates', 'europe'], feed_url: 'https://www.ecb.europa.eu/rss/press.html', causal_thesis: 'ECB policy moves EUR-denominated assets and European equity risk premia.' },
  { handle: 'bls_releases', display_name: 'BLS Data Releases', category: 'macro', causality_score: 0.94, weight: 2.3, causal_tags: ['macro', 'inflation'], feed_url: 'https://www.bls.gov/feed/latest_release.rss', causal_thesis: 'CPI/Payrolls data releases are the highest-impact scheduled macro events.' },
  { handle: 'cnbc_economy', display_name: 'CNBC Economy', category: 'macro', causality_score: 0.91, weight: 2.3, causal_tags: ['macro', 'rates'], feed_url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', causal_thesis: 'CNBC economic coverage moves retail and institutional sentiment quickly.' },
  { handle: 'forexlive', display_name: 'ForexLive', category: 'macro', causality_score: 0.89, weight: 2.1, causal_tags: ['rates', 'fx'], feed_url: 'https://www.forexlive.com/feed', causal_thesis: 'FX/rates commentary transmits quickly into equity index and commodity pricing.' },
  { handle: 'oilprice_rss', display_name: 'OilPrice.com', category: 'energy', causality_score: 0.93, weight: 2.4, causal_tags: ['energy', 'oil'], feed_url: 'https://oilprice.com/rss/main', causal_thesis: 'Energy supply and demand commentary moves oil-linked equities rapidly.' },
  { handle: 'reuters_energy', display_name: 'Reuters Commodities', category: 'energy', causality_score: 0.92, weight: 2.3, causal_tags: ['energy', 'commodities'], feed_url: 'https://feeds.reuters.com/reuters/commoditiesNews', causal_thesis: 'Reuters commodity news signals supply/demand changes for energy equities.' },
  { handle: 'eia_news', display_name: 'EIA Energy Data', category: 'energy', causality_score: 0.91, weight: 2.2, causal_tags: ['energy', 'oil'], feed_url: 'https://www.eia.gov/rss/nightly_energy_status.xml', causal_thesis: 'EIA inventory and production data is the primary scheduled oil price catalyst.' },
  { handle: 'defnews_rss', display_name: 'Defense News', category: 'defense', causality_score: 0.92, weight: 2.3, causal_tags: ['defense', 'procurement'], feed_url: 'https://www.defensenews.com/arc/outboundfeeds/rss/', causal_thesis: 'Defense contract awards and budget news directly drive defense equity valuations.' },
  { handle: 'break_defense', display_name: 'Breaking Defense', category: 'defense', causality_score: 0.90, weight: 2.2, causal_tags: ['defense', 'policy'], feed_url: 'https://breakingdefense.com/feed/', causal_thesis: 'Breaking defense procurement news moves major defense stocks immediately.' },
  { handle: 'warzone_rss', display_name: 'The War Zone', category: 'defense', causality_score: 0.86, weight: 2.0, causal_tags: ['defense', 'geopolitics'], feed_url: 'https://www.thedrive.com/the-war-zone/rss', causal_thesis: 'Combat operations and weapons deployment news signals defense demand escalation.' },
  { handle: 'isw_ukraine', display_name: 'ISW Ukraine', category: 'defense', causality_score: 0.87, weight: 2.0, causal_tags: ['defense', 'geopolitics'], feed_url: 'https://www.understandingwar.org/feeds/news', causal_thesis: 'Conflict analysis informs European defense rearmament sentiment.' },
  { handle: 'nvidia_blog', display_name: 'NVIDIA Blog', category: 'tech', causality_score: 0.90, weight: 2.1, causal_tags: ['tech', 'ai', 'chips'], feed_url: 'https://blogs.nvidia.com/feed/', causal_thesis: 'NVIDIA product and partnership announcements move GPU and AI infrastructure stocks.' },
  { handle: 'techcrunch', display_name: 'TechCrunch', category: 'tech', causality_score: 0.88, weight: 2.2, causal_tags: ['tech', 'ai'], feed_url: 'https://techcrunch.com/feed/', causal_thesis: 'TechCrunch funding and AI product news shifts tech sector momentum.' },
  { handle: 'di_se', display_name: 'Dagens Industri', category: 'swedish', causality_score: 0.92, weight: 2.3, causal_tags: ['swedish', 'omx'], feed_url: 'https://www.di.se/rss', causal_thesis: "Sweden's leading financial daily drives OMX positioning decisions." },
  { handle: 'breakit_se', display_name: 'Breakit', category: 'swedish', causality_score: 0.86, weight: 2.0, causal_tags: ['swedish', 'tech'], feed_url: 'https://www.breakit.se/feed/artiklar', causal_thesis: 'Swedish tech and startup news affects Nordic tech equity sentiment.' },
  { handle: 'coindesk', display_name: 'CoinDesk', category: 'crypto', causality_score: 0.88, weight: 2.2, causal_tags: ['crypto', 'regulation'], feed_url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', causal_thesis: 'CoinDesk regulatory news moves Coinbase and crypto-adjacent equities rapidly.' },
  { handle: 'igaming_gn', display_name: 'iGaming News (GN)', category: 'tech', causality_score: 0.89, weight: 2.1, causal_tags: ['gaming', 'regulation'], feed_url: 'https://news.google.com/rss/search?q=igaming+online+gambling+sports+betting+legalization&hl=en', causal_thesis: 'iGaming legalization news is the primary Evolution Gaming stock catalyst.' }
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeHandle(handle: string): string | null {
  const cleaned = `${handle || ''}`.trim().replace(/^@+/, '');
  if (!/^[A-Za-z0-9_]{2,15}$/.test(cleaned)) return null;
  return cleaned;
}

function inferCategoryFromText(text: string, fallback: TweetCategory): TweetCategory {
  const t = text.toLowerCase();
  if (/(sweden|swedish|stockholm|nordic|omx)/.test(t)) return 'swedish';
  if (/(crypto|bitcoin|ethereum|token|coinbase)/.test(t)) return 'crypto';
  if (/(oil|energy|gas|opec|brent|crude|lng)/.test(t)) return 'energy';
  if (/(defense|military|nato|war|missile|conflict)/.test(t)) return 'defense';
  if (/(ai|tech|semiconductor|chip|software|cloud|nvidia|tesla|palantir)/.test(t)) return 'tech';
  if (/(fed|ecb|inflation|rates|payroll|treasury|yield|macro|market)/.test(t)) return 'macro';
  return fallback;
}

function computeGraphScore(sourceScore: number, tweetText: string): number {
  const t = tweetText.toLowerCase();
  let bonus = 0;
  if (/(breaking|exclusive|urgent|confirmed)/.test(t)) bonus += 0.06;
  if (/(fed|ecb|inflation|rates|jobs|treasury|yield)/.test(t)) bonus += 0.08;
  if (/(oil|energy|opec|defense|war|nato|ai|semiconductor|earnings|guidance)/.test(t)) bonus += 0.08;
  return clamp(sourceScore * 0.78 + bonus, 0.25, 0.92);
}

function toWeight(causalityScore: number): number {
  return Number(clamp(0.5 + causalityScore * 2.0, 0.5, 2.5).toFixed(2));
}

function toTagSet(tags?: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter(tag => typeof tag === 'string' && tag.trim().length > 0))];
}

function mergeTagJson(existingJson: string | null, nextTags: string[]): string {
  let existing: string[] = [];
  try {
    existing = JSON.parse(existingJson || '[]');
  } catch {
    existing = [];
  }
  const merged = [...new Set([...existing, ...nextTags])];
  return JSON.stringify(merged);
}

export class TweetStore {
  constructor(private db: Database.Database) {}

  seedDefaultAccounts(targetUniverse = 1200): UniverseExpansionResult {
    const previousCount = this.getAccountCount();

    for (const account of CORE_CAUSAL_ACCOUNTS) {
      this.upsertTweetAccount({
        handle: account.handle,
        displayName: account.display_name,
        category: account.category,
        weight: account.weight,
        causalityScore: account.causality_score,
        discoverySource: 'seed',
        collectEnabled: true,
        discoveryDepth: 0,
        causalTags: account.causal_tags,
        causalThesis: account.causal_thesis,
        feedUrl: account.feed_url,
        isActive: true
      });
    }

    return this.expandUniverseToTarget(targetUniverse, 2200, previousCount);
  }

  expandUniverseToTarget(
    targetUniverse = 1200,
    maxSeedInserts = 2200,
    baselineCount?: number
  ): UniverseExpansionResult {
    let insertedFromSeed = 0;
    const previousCount = baselineCount ?? this.getAccountCount();
    let currentCount = previousCount;

    const targetSeedPopulation = Math.max(targetUniverse, 1200);
    const seedAccounts = (newsSources as NewsSourceAccount[]).slice(0, maxSeedInserts);

    for (const seedAccount of seedAccounts) {
      if (currentCount >= targetSeedPopulation && insertedFromSeed > 0) break;

      const handle = normalizeHandle(seedAccount.handle || '');
      if (!handle) continue;

      const category = this.normalizeCategory(seedAccount.category || 'macro');
      const score = clamp(Number(seedAccount.causality_score ?? 0.35), 0.10, 0.98);
      const result = this.upsertTweetAccount({
        handle,
        displayName: seedAccount.display_name || handle,
        category,
        weight: clamp(Number(seedAccount.weight ?? toWeight(score)), 0.5, 2.5),
        causalityScore: score,
        discoverySource: (seedAccount.discovery_source as TweetDiscoverySource) || 'dataset',
        collectEnabled: Boolean(seedAccount.collect_enabled) && score >= 0.68,
        discoveryDepth: Number(seedAccount.discovery_depth ?? 1),
        causalTags: toTagSet(seedAccount.causal_tags),
        causalThesis: seedAccount.causal_thesis || 'Market-relevant news flow contributes to sector-level sentiment shifts.',
        feedUrl: seedAccount.feed_url,
        isActive: true
      });

      if (result.inserted) {
        insertedFromSeed += 1;
        currentCount += 1;
      }
    }

    const discoveryResult = this.discoverConnectionsFromRecentTweets(48, 500);
    currentCount = this.getAccountCount();
    const collectionSetSize = this.rebalanceCollectionSet(140);

    return {
      previousCount,
      currentCount,
      insertedFromSeed,
      discoveredFromConnections: discoveryResult.accountsAdded,
      collectionSetSize
    };
  }

  getAccountCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM tweet_accounts').get() as { c: number };
    return row.c;
  }

  getActiveAccounts(limit = 1000): TweetAccount[] {
    return this.db.prepare(
      `SELECT * FROM tweet_accounts WHERE is_active = TRUE ORDER BY causality_score DESC, weight DESC LIMIT ?`
    ).all(limit) as TweetAccount[];
  }

  getAccountsForCollection(limit = 120): TweetAccount[] {
    return this.db.prepare(`
      SELECT *
      FROM tweet_accounts
      WHERE is_active = TRUE
        AND collect_enabled = TRUE
        AND feed_url IS NOT NULL
        AND feed_url != ''
      ORDER BY COALESCE(last_collected_at, last_scraped_at, '1970-01-01') ASC,
               causality_score DESC,
               weight DESC
      LIMIT ?
    `).all(limit) as TweetAccount[];
  }

  getUniverseStats() {
    const total = this.getAccountCount();
    const collectEnabled = (this.db.prepare(
      `SELECT COUNT(*) as c FROM tweet_accounts WHERE collect_enabled = TRUE`
    ).get() as { c: number }).c;

    const bySource = Object.fromEntries(
      (this.db.prepare(`
        SELECT discovery_source as source, COUNT(*) as c
        FROM tweet_accounts
        GROUP BY discovery_source
      `).all() as Array<{ source: string; c: number }>).map(row => [row.source, row.c])
    );

    const byCategory = Object.fromEntries(
      (this.db.prepare(`
        SELECT category, COUNT(*) as c
        FROM tweet_accounts
        GROUP BY category
      `).all() as Array<{ category: string; c: number }>).map(row => [row.category, row.c])
    );

    return {
      total,
      collect_enabled: collectEnabled,
      by_source: bySource,
      by_category: byCategory
    };
  }

  insertTweet(tweet: InsertTweet): boolean {
    const info = this.db.prepare(`
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

    return info.changes > 0;
  }

  markAccountScraped(handle: string): void {
    this.db.prepare(
      `UPDATE tweet_accounts
       SET last_scraped_at = datetime('now'),
           last_collected_at = datetime('now'),
           scrape_failures = 0
       WHERE handle = ?`
    ).run(handle);
  }

  markAccountFailed(handle: string): void {
    this.db.prepare(
      `UPDATE tweet_accounts SET scrape_failures = scrape_failures + 1 WHERE handle = ?`
    ).run(handle);
  }

  recordConnectionsFromTweet(sourceHandle: string, tweetText: string): ConnectionDiscoveryResult {
    const source = this.db.prepare(
      `SELECT handle, category, causality_score, discovery_depth FROM tweet_accounts WHERE handle = ?`
    ).get(sourceHandle) as { handle: string; category: TweetCategory; causality_score: number; discovery_depth: number } | undefined;

    if (!source) {
      return { accountsAdded: 0, connectionsAdded: 0 };
    }

    const mentions = new Set<string>();
    const regex = /@([A-Za-z0-9_]{2,15})/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(tweetText)) !== null) {
      const handle = normalizeHandle(match[1]);
      if (!handle) continue;
      if (handle.toLowerCase() === sourceHandle.toLowerCase()) continue;
      mentions.add(handle);
    }

    if (mentions.size === 0) {
      return { accountsAdded: 0, connectionsAdded: 0 };
    }

    let accountsAdded = 0;
    let connectionsAdded = 0;

    for (const targetHandle of mentions) {
      const evidence = tweetText.length > 240 ? `${tweetText.slice(0, 237)}...` : tweetText;

      const connectionInfo = this.db.prepare(`
        INSERT INTO tweet_account_connections (
          source_handle, target_handle, connection_type, evidence_text, weight, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'mention', ?, 1.0, datetime('now'), datetime('now'))
        ON CONFLICT(source_handle, target_handle, connection_type)
        DO UPDATE SET
          weight = tweet_account_connections.weight + 1.0,
          evidence_text = excluded.evidence_text,
          last_seen_at = datetime('now')
      `).run(sourceHandle, targetHandle, evidence);

      if (connectionInfo.changes > 0) {
        connectionsAdded += 1;
      }

      const inferredCategory = inferCategoryFromText(tweetText, source.category || 'unknown');
      const inferredScore = computeGraphScore(source.causality_score || 0.35, tweetText);
      const upsert = this.upsertTweetAccount({
        handle: targetHandle,
        displayName: targetHandle,
        category: inferredCategory,
        weight: toWeight(inferredScore),
        causalityScore: inferredScore,
        discoverySource: 'graph',
        collectEnabled: inferredScore >= 0.82,
        discoveryDepth: Number(source.discovery_depth || 0) + 1,
        causalTags: ['graph', inferredCategory],
        causalThesis: `Mentioned by @${sourceHandle}; may transmit ${inferredCategory} signal flow.`,
        isActive: true
      });

      if (upsert.inserted) {
        accountsAdded += 1;
      }
    }

    return { accountsAdded, connectionsAdded };
  }

  discoverConnectionsFromRecentTweets(hours = 48, maxAccountsToAdd = 250): ConnectionDiscoveryResult {
    const tweets = this.db.prepare(`
      SELECT account_handle, tweet_text
      FROM tweet_snapshots
      WHERE scraped_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY scraped_at DESC
      LIMIT 1200
    `).all(hours) as Array<{ account_handle: string; tweet_text: string }>;

    let accountsAdded = 0;
    let connectionsAdded = 0;

    for (const tweet of tweets) {
      if (accountsAdded >= maxAccountsToAdd) break;
      const result = this.recordConnectionsFromTweet(tweet.account_handle, tweet.tweet_text);
      accountsAdded += result.accountsAdded;
      connectionsAdded += result.connectionsAdded;
    }

    return { accountsAdded, connectionsAdded };
  }

  rebalanceCollectionSet(maxCollect = 120): number {
    this.db.prepare(`UPDATE tweet_accounts SET collect_enabled = FALSE WHERE is_active = TRUE`).run();

    const coreHandles = CORE_CAUSAL_ACCOUNTS.map(account => account.handle);
    const topHandles = this.db.prepare(`
      SELECT handle
      FROM tweet_accounts
      WHERE is_active = TRUE
        AND feed_url IS NOT NULL
        AND feed_url != ''
      ORDER BY
        CASE WHEN discovery_source = 'seed' THEN 1 ELSE 0 END DESC,
        causality_score DESC,
        weight DESC,
        scrape_failures ASC
      LIMIT ?
    `).all(maxCollect) as Array<{ handle: string }>;

    const selected = new Set<string>([...coreHandles, ...topHandles.map(row => row.handle)]);
    const stmt = this.db.prepare(`UPDATE tweet_accounts SET collect_enabled = TRUE WHERE handle = ?`);
    for (const handle of selected) {
      stmt.run(handle);
    }

    return selected.size;
  }

  getUnprocessedTweets(limit = 200): UnprocessedTweet[] {
    return this.db.prepare(`
      SELECT ts.*, ta.category, ta.weight
      FROM tweet_snapshots ts
      JOIN tweet_accounts ta ON ta.handle = ts.account_handle
      WHERE ts.ai_processed = FALSE
        AND ts.scraped_at >= datetime('now', '-24 hours')
      ORDER BY ta.causality_score DESC, ta.weight DESC, ts.scraped_at DESC
      LIMIT ?
    `).all(limit) as UnprocessedTweet[];
  }

  getRecentByCategory(category: TweetCategory, hours = 24): TweetSnapshot[] {
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
    universe: ReturnType<TweetStore['getUniverseStats']>;
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

    return {
      total,
      byCategory,
      bySentiment,
      topAccountActivity,
      universe: this.getUniverseStats()
    };
  }

  cleanupOld(daysToKeep: number): number {
    const deletedTweets = this.db.prepare(
      `DELETE FROM tweet_snapshots WHERE scraped_at < datetime('now', '-' || ? || ' days')`
    ).run(daysToKeep).changes;

    // Prune very low-confidence graph accounts with no collected tweets to keep universe healthy.
    this.db.prepare(`
      DELETE FROM tweet_accounts
      WHERE discovery_source = 'graph'
        AND causality_score < 0.30
        AND handle NOT IN (SELECT DISTINCT account_handle FROM tweet_snapshots)
    `).run();

    return deletedTweets;
  }

  private upsertTweetAccount(input: UpsertTweetAccountInput): { inserted: boolean } {
    const handle = normalizeHandle(input.handle);
    if (!handle) return { inserted: false };

    const existing = this.db.prepare(`SELECT * FROM tweet_accounts WHERE handle = ?`).get(handle) as TweetAccount | undefined;
    const category = this.normalizeCategory(input.category);
    const score = clamp(input.causalityScore, 0.10, 0.99);
    const weight = clamp(input.weight, 0.5, 2.5);
    const tags = toTagSet(input.causalTags);

    if (!existing) {
      this.db.prepare(`
        INSERT INTO tweet_accounts (
          handle, display_name, category, weight, is_active,
          discovery_source, causality_score, causal_tags, causal_thesis,
          discovery_depth, collect_enabled, feed_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        handle,
        input.displayName || handle,
        category,
        weight,
        input.isActive === false ? 0 : 1,
        input.discoverySource,
        score,
        JSON.stringify(tags),
        input.causalThesis || null,
        Number(input.discoveryDepth ?? 0),
        input.collectEnabled ? 1 : 0,
        input.feedUrl || null
      );
      return { inserted: true };
    }

    const mergedTags = mergeTagJson(existing.causal_tags, tags);
    const mergedSource: TweetDiscoverySource = existing.discovery_source === 'seed'
      ? 'seed'
      : (existing.discovery_source || input.discoverySource);

    const mergedCategory: TweetCategory = existing.discovery_source === 'seed'
      ? this.normalizeCategory(existing.category)
      : category;

    const mergedScore = Math.max(existing.causality_score || 0.0, score);
    const mergedWeight = Math.max(existing.weight || 0.5, weight);
    const mergedDepth = Math.min(Number(existing.discovery_depth || 0), Number(input.discoveryDepth ?? existing.discovery_depth ?? 0));
    const mergedCollect = Boolean(existing.collect_enabled) || Boolean(input.collectEnabled) || mergedScore >= 0.82;

    this.db.prepare(`
      UPDATE tweet_accounts
      SET display_name = COALESCE(?, display_name),
          category = ?,
          weight = ?,
          is_active = ?,
          discovery_source = ?,
          causality_score = ?,
          causal_tags = ?,
          causal_thesis = COALESCE(?, causal_thesis),
          discovery_depth = ?,
          collect_enabled = ?,
          feed_url = COALESCE(?, feed_url)
      WHERE handle = ?
    `).run(
      input.displayName || null,
      mergedCategory,
      mergedWeight,
      input.isActive === false ? 0 : 1,
      mergedSource,
      mergedScore,
      mergedTags,
      input.causalThesis || null,
      Number.isFinite(mergedDepth) ? mergedDepth : 0,
      mergedCollect ? 1 : 0,
      input.feedUrl || null,
      handle
    );

    return { inserted: false };
  }

  private normalizeCategory(category: string): TweetCategory {
    if (category === 'macro' || category === 'energy' || category === 'defense' || category === 'tech' || category === 'swedish' || category === 'crypto') {
      return category;
    }
    return 'unknown';
  }
}

