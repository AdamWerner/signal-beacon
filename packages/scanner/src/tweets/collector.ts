import { TweetStore, InsertTweet, TweetAccount } from '../storage/tweet-store.js';

const NITTER_INSTANCES = [
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
  'https://nitter.woodland.cafe'
];

const RSSHUB_BASE = 'https://rsshub.app/twitter/user';

export interface CollectorResult {
  accountsProcessed: number;
  tweetsCollected: number;
  errors: number;
  accountsAdded: number;
  connectionsAdded: number;
  duration: number;
}

export class TweetCollector {
  private nitterIndex = 0;

  constructor(private store: TweetStore) {}

  /**
   * Collect recent tweets from the high-causality subset of the universe.
   */
  async collectAll(maxAccounts = 120): Promise<CollectorResult> {
    const start = Date.now();
    const accounts = this.store.getAccountsForCollection(maxAccounts);

    let tweetsCollected = 0;
    let errors = 0;
    let accountsAdded = 0;
    let connectionsAdded = 0;

    for (const account of accounts) {
      try {
        const result = await this.collectForAccount(account);
        tweetsCollected += result.tweetsCollected;
        accountsAdded += result.accountsAdded;
        connectionsAdded += result.connectionsAdded;
        this.store.markAccountScraped(account.handle);
      } catch (err) {
        errors += 1;
        this.store.markAccountFailed(account.handle);
        console.error(`  Tweet collection failed for @${account.handle}:`, err);
      }

      await this.delay(1500);
    }

    return {
      accountsProcessed: accounts.length,
      tweetsCollected,
      errors,
      accountsAdded,
      connectionsAdded,
      duration: Date.now() - start
    };
  }

  private async collectForAccount(account: TweetAccount): Promise<{ tweetsCollected: number; accountsAdded: number; connectionsAdded: number }> {
    const tweets = await this.fetchNitterRss(account.handle);
    const sourceTweets = tweets.length > 0 ? tweets : await this.fetchRssHub(account.handle);

    if (sourceTweets.length === 0) {
      return { tweetsCollected: 0, accountsAdded: 0, connectionsAdded: 0 };
    }

    let tweetsCollected = 0;
    let accountsAdded = 0;
    let connectionsAdded = 0;

    for (const tweet of sourceTweets) {
      const inserted = this.store.insertTweet(tweet);
      if (!inserted) continue;

      tweetsCollected += 1;
      const discovery = this.store.recordConnectionsFromTweet(account.handle, tweet.tweet_text);
      accountsAdded += discovery.accountsAdded;
      connectionsAdded += discovery.connectionsAdded;
    }

    return { tweetsCollected, accountsAdded, connectionsAdded };
  }

  private async fetchNitterRss(handle: string): Promise<InsertTweet[]> {
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
        continue;
      }
    }

    return [];
  }

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

  private parseRssXml(xml: string, handle: string): InsertTweet[] {
    const tweets: InsertTweet[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1] || match[2];
      if (!block) continue;

      const title = this.extractTag(block, 'title');
      const description = this.extractTag(block, 'description') || this.extractTag(block, 'content');
      const link = this.extractTag(block, 'link') || this.extractAttr(block, 'link', 'href');
      const pubDate = this.extractTag(block, 'pubDate') || this.extractTag(block, 'published');
      const guid = this.extractTag(block, 'guid') || this.extractTag(block, 'id');

      let tweetText = description || title || '';
      tweetText = tweetText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      if (tweetText.startsWith('RT @')) continue;
      if (tweetText.length < 20) continue;

      if (pubDate) {
        const tweetDate = new Date(pubDate);
        const hoursAgo = (Date.now() - tweetDate.getTime()) / (1000 * 60 * 60);
        if (hoursAgo > 48) continue;
      }

      const tweetIdMatch = (link || guid || '').match(/status\/(\d+)/);
      const tweetId = tweetIdMatch ? tweetIdMatch[1] : (guid || `${handle}_${Date.now()}_${tweets.length}`);

      tweets.push({
        account_handle: handle,
        tweet_id: tweetId,
        tweet_text: tweetText.substring(0, 2000),
        tweet_url: link || undefined,
        posted_at: pubDate ? new Date(pubDate).toISOString() : undefined
      });
    }

    return tweets;
  }

  private extractTag(xml: string, tag: string): string | null {
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
