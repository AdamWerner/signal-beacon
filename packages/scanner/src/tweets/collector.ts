import { TweetStore, InsertTweet, TweetAccount } from '../storage/tweet-store.js';

/**
 * TweetCollector — scrapes tweets from influential financial accounts.
 *
 * Strategy:
 * 1. Primary: Nitter RSS feeds (self-hosted or public instances)
 * 2. Fallback: RSSHub (rsshub.app/twitter/user/handle)
 * 3. Manual: POST /api/tweets/import endpoint for pasting tweets
 *
 * The collector does NOT process tweets with AI. It just stuffs them into
 * tweet_snapshots. The IntelligenceEngine batches unprocessed tweets and
 * runs a single Claude CLI call to extract signals from them.
 *
 * This is intentionally cheap on tokens — we accumulate raw text in the DB,
 * then do ONE AI call per briefing cycle with the batch.
 */

// Known Nitter instances (try in order, fall back if blocked)
const NITTER_INSTANCES = [
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
  'https://nitter.woodland.cafe',
];

// RSSHub fallback
const RSSHUB_BASE = 'https://rsshub.app/twitter/user';

export interface CollectorResult {
  accountsProcessed: number;
  tweetsCollected: number;
  errors: number;
  duration: number;
}

export class TweetCollector {
  private nitterIndex = 0; // Rotate through instances

  constructor(private store: TweetStore) {}

  /**
   * Collect recent tweets from all active accounts.
   * Called every scan cycle (10 min) or on a slower cadence (30 min).
   */
  async collectAll(): Promise<CollectorResult> {
    const start = Date.now();
    const accounts = this.store.getActiveAccounts();

    let tweetsCollected = 0;
    let errors = 0;

    for (const account of accounts) {
      try {
        const count = await this.collectForAccount(account);
        tweetsCollected += count;
        this.store.markAccountScraped(account.handle);
      } catch (err) {
        errors++;
        this.store.markAccountFailed(account.handle);
        console.error(`  ✕ Tweet collection failed for @${account.handle}:`, err);
      }

      // Rate limit: 1-2 seconds between accounts
      await this.delay(1500);
    }

    return {
      accountsProcessed: accounts.length,
      tweetsCollected,
      errors,
      duration: Date.now() - start
    };
  }

  /**
   * Collect tweets for a single account via RSS
   */
  private async collectForAccount(account: TweetAccount): Promise<number> {
    // Try Nitter RSS first
    const tweets = await this.fetchNitterRss(account.handle);

    if (tweets.length === 0) {
      // Try RSSHub fallback
      const rsshubTweets = await this.fetchRssHub(account.handle);
      if (rsshubTweets.length > 0) {
        for (const tweet of rsshubTweets) {
          this.store.insertTweet(tweet);
        }
        return rsshubTweets.length;
      }
      return 0;
    }

    for (const tweet of tweets) {
      this.store.insertTweet(tweet);
    }

    return tweets.length;
  }

  /**
   * Fetch tweets via Nitter RSS
   */
  private async fetchNitterRss(handle: string): Promise<InsertTweet[]> {
    // Rotate through Nitter instances
    for (let i = 0; i < NITTER_INSTANCES.length; i++) {
      const instance = NITTER_INSTANCES[(this.nitterIndex + i) % NITTER_INSTANCES.length];
      const url = `${instance}/${handle}/rss`;

      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'PolySignal/1.0' },
          signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) continue;

        const xml = await response.text();
        const tweets = this.parseRssXml(xml, handle);

        if (tweets.length > 0) {
          this.nitterIndex = (this.nitterIndex + i) % NITTER_INSTANCES.length;
          return tweets;
        }
      } catch {
        // Try next instance
        continue;
      }
    }

    return [];
  }

  /**
   * Fetch tweets via RSSHub
   */
  private async fetchRssHub(handle: string): Promise<InsertTweet[]> {
    const url = `${RSSHUB_BASE}/${handle}`;

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'PolySignal/1.0' },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) return [];

      const xml = await response.text();
      return this.parseRssXml(xml, handle);
    } catch {
      return [];
    }
  }

  /**
   * Parse RSS/Atom XML into tweet objects.
   * Works with both Nitter RSS and RSSHub formats.
   */
  private parseRssXml(xml: string, handle: string): InsertTweet[] {
    const tweets: InsertTweet[] = [];

    // Simple XML parsing — extract <item> or <entry> blocks
    const itemRegex = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1] || match[2];
      if (!block) continue;

      const title = this.extractTag(block, 'title');
      const description = this.extractTag(block, 'description') || this.extractTag(block, 'content');
      const link = this.extractTag(block, 'link') || this.extractAttr(block, 'link', 'href');
      const pubDate = this.extractTag(block, 'pubDate') || this.extractTag(block, 'published');
      const guid = this.extractTag(block, 'guid') || this.extractTag(block, 'id');

      // Extract tweet text — prefer description (full text), fall back to title
      let tweetText = description || title || '';

      // Strip HTML tags
      tweetText = tweetText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      // Skip retweets (optional — might want to keep high-weight RT)
      if (tweetText.startsWith('RT @')) continue;

      // Skip very short tweets (likely noise)
      if (tweetText.length < 20) continue;

      // Only keep recent tweets (last 24 hours if date available)
      if (pubDate) {
        const tweetDate = new Date(pubDate);
        const hoursAgo = (Date.now() - tweetDate.getTime()) / (1000 * 60 * 60);
        if (hoursAgo > 48) continue; // Skip tweets older than 48h
      }

      // Extract tweet ID from link or guid
      const tweetIdMatch = (link || guid || '').match(/status\/(\d+)/);
      const tweetId = tweetIdMatch ? tweetIdMatch[1] : (guid || `${handle}_${Date.now()}_${tweets.length}`);

      tweets.push({
        account_handle: handle,
        tweet_id: tweetId,
        tweet_text: tweetText.substring(0, 2000), // Cap at 2000 chars
        tweet_url: link || undefined,
        posted_at: pubDate ? new Date(pubDate).toISOString() : undefined,
      });
    }

    return tweets;
  }

  private extractTag(xml: string, tag: string): string | null {
    // Handle CDATA
    const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
    const cdataMatch = xml.match(cdataRegex);
    if (cdataMatch) return cdataMatch[1].trim();

    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
  }

  private extractAttr(xml: string, tag: string, attr: string): string | null {
    const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
    const match = xml.match(regex);
    return match ? match[1] : null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
