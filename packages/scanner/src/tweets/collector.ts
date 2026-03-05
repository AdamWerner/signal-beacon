import { TweetStore, InsertTweet, TweetAccount } from '../storage/tweet-store.js';

export interface CollectorResult {
  accountsProcessed: number;
  tweetsCollected: number;
  errors: number;
  accountsAdded: number;
  connectionsAdded: number;
  duration: number;
}

/**
 * NewsCollector — fetches RSS/Atom feeds from financial news sources.
 * Replaces the defunct Nitter/Twitter scraping approach.
 * Uses the feed_url stored on each tweet_account row.
 */
export class TweetCollector {
  constructor(private store: TweetStore) {}

  async collectAll(maxAccounts = 120): Promise<CollectorResult> {
    const start = Date.now();
    const accounts = this.store.getAccountsForCollection(maxAccounts);

    let tweetsCollected = 0;
    let errors = 0;

    for (const account of accounts) {
      if (!account.feed_url) continue;

      try {
        const collected = await this.collectFeed(account);
        tweetsCollected += collected;
        this.store.markAccountScraped(account.handle);
      } catch (err) {
        errors += 1;
        this.store.markAccountFailed(account.handle);
        console.error(`  News feed failed for ${account.handle}:`, err);
      }

      await this.delay(500);
    }

    return {
      accountsProcessed: accounts.length,
      tweetsCollected,
      errors,
      accountsAdded: 0,
      connectionsAdded: 0,
      duration: Date.now() - start
    };
  }

  private async collectFeed(account: TweetAccount): Promise<number> {
    const url = account.feed_url!;
    let xml: string;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'PolySignal/2.0 (financial-news-aggregator)',
          'Accept': 'application/rss+xml, application/atom+xml, text/xml, application/xml'
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) return 0;
      xml = await response.text();
    } catch {
      return 0;
    }

    const items = this.parseRssXml(xml, account.handle);
    let inserted = 0;

    for (const item of items) {
      if (this.store.insertTweet(item)) {
        inserted += 1;
      }
    }

    return inserted;
  }

  private parseRssXml(xml: string, handle: string): InsertTweet[] {
    const items: InsertTweet[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1] || match[2];
      if (!block) continue;

      const title = this.extractTag(block, 'title');
      const description = this.extractTag(block, 'description') || this.extractTag(block, 'content') || this.extractTag(block, 'summary');
      const link = this.extractTag(block, 'link') || this.extractAttr(block, 'link', 'href');
      const pubDate = this.extractTag(block, 'pubDate') || this.extractTag(block, 'published') || this.extractTag(block, 'updated');
      const guid = this.extractTag(block, 'guid') || this.extractTag(block, 'id');

      // Prefer description for content, fall back to title
      let text = description || title || '';
      text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      if (text.length < 20) continue;

      if (pubDate) {
        const itemDate = new Date(pubDate);
        if (isNaN(itemDate.getTime())) {
          // unparseable date — skip age check, include
        } else {
          const hoursAgo = (Date.now() - itemDate.getTime()) / (1000 * 60 * 60);
          if (hoursAgo > 48) continue;
        }
      }

      // Use link or guid directly as unique ID (RSS items use URLs, not Twitter status IDs)
      const tweetId = link || guid || `${handle}_${Date.now()}_${items.length}`;

      items.push({
        account_handle: handle,
        tweet_id: tweetId.substring(0, 512),
        tweet_text: text.substring(0, 2000),
        tweet_url: link || undefined,
        posted_at: pubDate ? new Date(pubDate).toISOString() : undefined
      });
    }

    return items;
  }

  private extractTag(xml: string, tag: string): string | null {
    const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
    const cdataMatch = xml.match(cdataRegex);
    if (cdataMatch) return cdataMatch[1].trim();

    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const m = xml.match(regex);
    return m ? m[1].trim() : null;
  }

  private extractAttr(xml: string, tag: string, attr: string): string | null {
    const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
    const m = xml.match(regex);
    return m ? m[1] : null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
